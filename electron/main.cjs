'use strict';
const {app,BrowserWindow,ipcMain,dialog,Menu,shell,net,clipboard}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {FileStore}=require('./files.cjs');
const {SendQueue}=require('./queue.cjs');
const {DeliveryBroker}=require('./delivery.cjs');
const {ScheduleManager}=require('./schedules.cjs');
const {createBackend}=require('./native/index.cjs');
const {ManualUpdates,RELEASE_PAGE}=require('./updates.cjs');
const {restoreSession,saveSession}=require('./session.cjs');
const {LogWorker,workerCommand}=require('./log-worker.cjs');
app.setName('工具工作台');
const profile=app.commandLine.getSwitchValue('user-data-dir');
if(path.isAbsolute(profile))app.setPath('userData',profile);
if(!app.requestSingleInstanceLock()){app.quit();}else{
let pickEpoch=0;
let savingSchedule=false;
let win,backend,queue,broker,schedules,picker,manualTarget=null,draftTarget=null,updates,sessionFile,restored,log,closing=false,approvedClose=false,closeReason=null,finalizingClose=false;
const files=new FileStore();
const page=pathToFileURL(path.join(__dirname,'../src/index.html')).href;
function cancelPick(){pickEpoch++;if(!picker)return;clearInterval(picker.timer);picker.resolve({cancelled:true});picker=null;}
function releaseDraft(){if(draftTarget){backend.release(draftTarget.id);draftTarget=null;}}
function emit(channel,data){if(win&&!win.isDestroyed())win.webContents.send(channel,data);}
function emitToolActivity(){emit('desktop:tool-activity',{command:!!queue.run||schedules.snapshot().some(job=>job.enabled)});}
function windowState(){return {maximized:win.isMaximized(),fullscreen:win.isFullScreen(),pinned:win.isAlwaysOnTop()};}
function handle(name,fn){ipcMain.handle(name,async(event,...args)=>{
  if(event.sender!==win?.webContents||event.senderFrame?.url!==page)throw new Error('无法识别请求来源');
  try{return {ok:true,value:await fn(...args)};}catch(error){return {ok:false,error:String(error.message||error)};}
});}
function unlocked(){if(queue?.run)throw new Error('发送期间不能修改文件或目标');}
async function readSettings(file){
  try{return JSON.parse(await fs.readFile(file,'utf8'))||{};}catch{return {};}
}
function logAvailable(){
  if(closing)throw new Error('请先完成退出或升级确认');
  if(log.busy||picker||log.state.stage==='connecting')throw new Error('请先完成当前采集操作');
  if(!log.child||log.state.stage==='unavailable')throw new Error('请先连接采集引擎');
}
function logIdle(){
  logAvailable();
  if(log.state.active)throw new Error('请先停止采集');
}
async function requestClose(reason='quit'){
  if(closing)return;
  if(log.busy){
    await dialog.showMessageBox(win,{type:'info',message:'操作完成后可关闭'});
    return;
  }
  closing=true;closeReason=reason;cancelPick();
  try{
    if(log.state.active){
      const confirm=await dialog.showMessageBox(win,{type:'question',message:'正在采集',
        detail:reason==='update'?'升级将停止采集并保存日志，确定继续吗？':'退出将停止采集并保存日志，确定退出吗？',
        buttons:['取消','继续'],defaultId:0,cancelId:0,noLink:true});
      if(confirm.response!==1){closing=false;closeReason=null;return;}
    }
    await Promise.all([queue?.stop(),schedules?.stopAll()]);emit('desktop:request-close',{reason});
  }catch(error){closing=false;closeReason=null;schedules?.reopen();throw error;}
}
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
app.whenReady().then(async()=>{
  const store=app.getPath('userData');
  const scheduleFile=path.join(store,'schedules.json');
  const windowSettings=path.join(store,'window.json');
  sessionFile=path.join(store,'session.json');
  await fs.mkdir(store,{recursive:true});
  if(process.platform==='win32'){
    const legacy=path.join(app.getPath('appData'),'命令定向');
    for(const file of [sessionFile,scheduleFile]){
      try{await fs.copyFile(path.join(legacy,path.basename(file)),file,require('node:fs').constants.COPYFILE_EXCL);}
      catch(error){if(!['ENOENT','EEXIST'].includes(error.code))console.warn('无法导入旧版命令定向配置',error.code);}
    }
  }
  restored=await restoreSession(sessionFile,files);
  const preferences=await readSettings(windowSettings);
  const legacyWindow=process.platform==='win32'?await readSettings(path.join(process.env.APPDATA||app.getPath('appData'),'LogCollector','config.json')):{};
  let pinWrite=Promise.resolve();
  const updater=process.platform==='win32'&&app.isPackaged?require('electron-updater').autoUpdater:null;
  if(updater)updater.installDirectory=path.dirname(app.getPath('exe'));
  updates=new ManualUpdates({updater,version:app.getVersion(),packaged:app.isPackaged,
    fetchRelease:async url=>{const response=await net.fetch(url,{headers:{Accept:'application/vnd.github+json'}});if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.json();}});
  updates.on('state',state=>{if(state.phase==='error'&&closeReason==='update'){closing=false;approvedClose=false;closeReason=null;schedules?.reopen();}emit('desktop:update',state);});
  backend=createBackend();broker=new DeliveryBroker(backend);queue=new SendQueue(broker.channel());
  schedules=new ScheduleManager({backend,broker,file:scheduleFile});await schedules.load();
  queue.on('state',state=>{emit('desktop:queue',state);emitToolActivity();});
  schedules.on('state',state=>{emit('desktop:schedules',state);emitToolActivity();});
  schedules.on('groups',groups=>emit('desktop:schedule-groups',groups));
  log=new LogWorker({command:process.platform==='win32'?workerCommand({packaged:app.isPackaged,resources:process.resourcesPath,root:path.join(__dirname,'..')}):null,config:path.join(store,'collector.json')});
  log.on('state',state=>emit('desktop:log-state',state));
  win=new BrowserWindow({width:1100,height:760,minWidth:680,minHeight:440,title:'工具工作台',icon:path.join(__dirname,'../assets/workbench.png'),backgroundColor:'#f7f8f7',show:false,frame:false,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
  if((preferences.pinned??legacyWindow.always_on_top)===true)win.setAlwaysOnTop(true);
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url!==page)event.preventDefault();});
  win.webContents.session.on('will-download',event=>event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  win.webContents.on('did-finish-load',()=>backend.setExcludedPids([win.webContents.getOSProcessId()]));
  win.once('ready-to-show',()=>win.show());
  win.on('close',event=>{if(!approvedClose){event.preventDefault();requestClose().catch(error=>dialog.showErrorBox('无法退出',error.message));}});
  win.on('closed',()=>{cancelPick();log.close();backend.dispose();win=null;app.quit();});
  for(const event of ['maximize','unmaximize','enter-full-screen','leave-full-screen'])win.on(event,()=>emit('desktop:window-state',windowState()));
  handle('desktop:config',()=>({platform:process.platform,version:app.getVersion(),accessibility:backend.permission(),window:windowState(),update:updates.snapshot(),session:restored,schedules:schedules.snapshot(),scheduleGroups:schedules.groupSnapshot()}));
  handle('desktop:window-minimize',()=>win.minimize());
  handle('desktop:window-maximize',()=>{
    if(win.isFullScreen())win.setFullScreen(false);
    else if(win.isMaximized())win.unmaximize();
    else win.maximize();
  });
  handle('desktop:window-close',()=>requestClose());
  handle('desktop:update-check',()=>updates.check());
  handle('desktop:update-download',()=>updates.download());
  handle('desktop:update-page',()=>shell.openExternal(RELEASE_PAGE));
  handle('desktop:update-install',()=>{if(updates.state.phase!=='downloaded')throw new Error('升级包尚未下载完成');return requestClose('update');});
  handle('desktop:open',async()=>{
    unlocked();const selection=await dialog.showOpenDialog(win,{title:'打开 TXT 文件',properties:['openFile','multiSelections'],filters:[{name:'UTF-8 文本',extensions:['txt']} ]});
    const results=[];for(const file of selection.filePaths){try{results.push(await files.open(file));}catch(error){await dialog.showMessageBox(win,{type:'error',message:`无法打开 ${path.basename(file)}`,detail:error.message});}}
    return results;
  });
  handle('desktop:save',async(id,text)=>{
    unlocked();if(typeof id!=='string')throw new Error('文件标识无效');
    try{return await files.save(id,text);}catch(error){
      if(error.code!=='FILE_CHANGED')throw error;
      const choice=await dialog.showMessageBox(win,{type:'warning',message:'原文件已被其他程序修改',detail:'覆盖将替换磁盘上的内容。取消可保留你在本工具中的修改。',buttons:['取消','覆盖原文件'],defaultId:0,cancelId:0,noLink:true});
      if(choice.response!==1)return {cancelled:true};return files.save(id,text,{overwrite:true});
    }
  });
  handle('desktop:close-file',id=>{unlocked();return files.close(id);});
  handle('desktop:pin',async()=>{
    const pinned=!win.isAlwaysOnTop();
    win.setAlwaysOnTop(pinned);
    emit('desktop:window-state',windowState());
    const save=pinWrite.then(async()=>{
      const temp=windowSettings+'.tmp';
      await fs.writeFile(temp,JSON.stringify({pinned}));
      await fs.rename(temp,windowSettings);
    });
    pinWrite=save.catch(()=>{});
    await save;
    return pinned;
  });
  handle('desktop:accessibility',async()=>{
    if(process.platform==='darwin')await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    return backend.permission();
  });
  handle('desktop:pick',(options={})=>{
    const scope=options?.scope==='schedule'?'schedule':'manual';
    const scheduleId=scope==='schedule'?options.scheduleId:undefined;
    if(closing)throw new Error('正在退出');
    if(scheduleId!==undefined)schedules.get(scheduleId);
    unlocked();if(!backend.permission())throw new Error('请先在系统设置 → 隐私与安全性 → 辅助功能中允许「命令定向」，再重新拖选目标。');
    cancelPick();return new Promise((resolve,reject)=>{
      const started=Date.now(),epoch=pickEpoch;picker={kind:'command',resolve,reject,timer:setInterval(()=>{
        const current=picker;
        try{
          if(backend.escapeDown()||Date.now()-started>60000){cancelPick();return;}
          if(backend.mouseDown())return;
          clearInterval(current.timer);picker=null;
          current.resolve((async()=>{
            const target=await backend.pick();
            backend.retain(target.id);
            if(epoch!==pickEpoch){backend.release(target.id);return {cancelled:true};}
            if(scheduleId!==undefined){
              try{return {target,...await schedules.bindTarget(scheduleId,target)};}
              finally{backend.release(target.id);}
            }
            if(scope==='schedule'){releaseDraft();draftTarget=target;}
            else{if(manualTarget)backend.release(manualTarget.id);manualTarget=target;}
            return target;
          })());
        }catch(error){clearInterval(current.timer);if(picker===current)picker=null;current.reject(error);}
      },30)};
    });
  });
  handle('desktop:cancel-pick',()=>{if(picker?.kind!=='log')cancelPick();});
  handle('desktop:log-state',()=>log.state);
  handle('desktop:log-connect',()=>{if(!closing)log.connect();return log.state;});
  handle('desktop:log-pick',()=>{
    logIdle();
    return new Promise((resolve,reject)=>{
      const started=Date.now();
      picker={kind:'log',resolve,reject,timer:setInterval(()=>{
        const current=picker;
        if(backend.escapeDown()||Date.now()-started>60000){cancelPick();return;}
        if(backend.mouseDown())return;
        clearInterval(current.timer);
        picker=null;
        try{resolve(log.request('bind',backend.pointerHit()));}
        catch(error){reject(error);}
      },30)};
    });
  });
  handle('desktop:log-cancel-pick',()=>{if(picker?.kind==='log')cancelPick();});
  handle('desktop:log-retry',()=>{logIdle();return log.request('retry');});
  handle('desktop:log-toggle',()=>{
    logAvailable();
    return log.request(log.state.active?'stop':'start');
  });
  handle('desktop:log-output',async()=>{
    logIdle();
    const selected=await dialog.showOpenDialog(win,{title:'选择日志保存位置',defaultPath:log.state.output,properties:['openDirectory','createDirectory']});
    if(!selected.canceled&&selected.filePaths[0]){
      logIdle();
      return log.request('output',selected.filePaths[0]);
    }
    return log.state;
  });
  handle('desktop:log-copy',mode=>{
    const {output,lastFile}=log.state;
    const copies={output,filename:lastFile?path.basename(lastFile):null,path:lastFile};
    if(!Object.hasOwn(copies,mode)||!copies[mode])return false;
    clipboard.writeText(copies[mode]);
    return true;
  });
  handle('desktop:log-open',async()=>{
    if(!log.state.lastFile)return;
    const error=await shell.openPath(log.state.lastFile);
    if(error)throw new Error(error);
  });
  handle('desktop:schedule-draft-release',releaseDraft);
  handle('desktop:schedule-save',async value=>{
    if(closing||picker)throw new Error('请先完成目标拾取或退出确认');
    if(savingSchedule)throw new Error('正在保存定时任务');
    const targetId=value?.targetId;
    const picked=targetId&&draftTarget?.id===targetId?draftTarget:null;
    if(!value?.id&&!picked)throw new Error('请为新任务拖动选择发送目标');
    const saved=targetId&&value?.id?schedules.get(value.id).target:null;
    const target=picked||(saved?.id===targetId?saved:null);
    if(targetId&&!target)throw new Error('目标未绑定或已失效');
    const bound=target?{...target,alias:typeof value.targetAlias==='string'?value.targetAlias.slice(0,80):target.alias}:null;
    // Keep a picked target alive if the dialog closes while saving the task.
    if(picked)backend.retain(picked.id);
    savingSchedule=true;
    try{
      const result=await schedules.save(value,bound);
      if(picked&&draftTarget===picked)releaseDraft();
      return result;
    }finally{
      savingSchedule=false;
      if(picked)backend.release(picked.id);
    }
  });
  handle('desktop:schedule-action',(id,action)=>{if(closing)throw new Error('正在退出');return schedules.action(id,action);});
  handle('desktop:schedule-move',(id,position)=>schedules.move(id,position));
  handle('desktop:schedule-group-save',value=>schedules.saveGroup(value));
  handle('desktop:schedule-group-action',(id,action)=>schedules.groupAction(id,action));
  handle('desktop:start',options=>{if(closing)throw new Error('请先完成退出或升级确认');if(picker)throw new Error('请先完成目标拾取');return queue.start(options||{});});
  handle('desktop:pause',()=>queue.pause());handle('desktop:resume',()=>queue.resume());handle('desktop:stop',()=>queue.stop());
  handle('desktop:close-response',async(confirm,activeId)=>{
    if(finalizingClose)return;
    if(confirm!==true){closing=false;closeReason=null;schedules.reopen();return;}
    if(!closing)throw new Error('退出请求已取消');
    finalizingClose=true;
    try{
      await Promise.all([queue.stop(),schedules.stopAll(),pinWrite]);
      await saveSession(sessionFile,files,activeId);
      if(log.state.active)await log.request('stop');
      approvedClose=true;
      if(closeReason==='update')updates.install();else win.close();
    }catch(error){closing=false;approvedClose=false;closeReason=null;schedules.reopen();throw error;}
    finally{finalizingClose=false;}
  });
  const edit={label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]};
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform==='darwin'?[{label:'工具工作台',submenu:[{role:'about',label:'关于工具工作台'},{type:'separator'},{role:'hide',label:'隐藏工具工作台'},{role:'hideOthers',label:'隐藏其他应用'},{role:'unhide',label:'显示全部'},{type:'separator'},{label:'退出工具工作台',accelerator:'Cmd+Q',click:()=>void requestClose()}]}]:[]),
    {label:'文件',submenu:[{label:'打开…',accelerator:'CmdOrCtrl+O',click:()=>emit('desktop:open-request')},{label:'保存',accelerator:'CmdOrCtrl+S',click:()=>emit('desktop:save-request')},{type:'separator'},{label:'关闭窗口',accelerator:'CmdOrCtrl+W',click:()=>void requestClose()}]},edit,
    {label:'窗口',submenu:[{role:'minimize',label:'最小化'},{role:'zoom',label:'缩放'}]}
  ]));
  if(process.platform!=='darwin')win.removeMenu();
  log.connect();
  void win.loadURL(page);
}).catch(error=>{log?.close();console.error(error);dialog.showErrorBox('无法启动工具工作台',error.stack||error.message);app.exit(1);});
app.on('before-quit',event=>{if(win&&!approvedClose){event.preventDefault();void requestClose();}});
app.on('window-all-closed',()=>app.quit());
}


