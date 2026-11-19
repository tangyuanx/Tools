import {bindTargetDrag} from './target-drag.js';

const tools=[
  {id:'command',name:'命令定向',english:'Cmd Send',group:'设备调试',icon:'terminal',pinned:true},
  {id:'collector',name:'日志采集',english:'Log Collector',group:'日志处理',icon:'file',pinned:true},
];
const $=id=>document.getElementById(id);

export function initSuite({desktop,icon,toast,hideCommand,showCommand,showLogHelp}){
  const catalog=$('toolCatalog');
  const search=$('toolSearch');
  const shortcuts=$('toolShortcuts');
  const listing=$('toolCatalogList');
  let active=tools[0];
  let commandRunning=false;
  let collectorRunning=false;

  function entry(tool){
    const tab=document.createElement('button');
    const item=document.createElement('button');
    tab.type=item.type='button';
    tab.className='suite-tool-button';
    item.className='suite-catalog-item';
    tab.id=tool.id+'Tab';
    tab.title=tool.name;
    tab.setAttribute('aria-label',tool.name);
    tab.setAttribute('role','tab');
    tab.setAttribute('aria-controls',tool.id+'View');
    tab.innerHTML=icon(tool.icon)+'<span class="suite-dot" hidden></span>';
    item.innerHTML=icon(tool.icon);
    const label=document.createElement('span');
    label.textContent=tool.name;
    const dot=document.createElement('span');
    dot.className='suite-dot';
    dot.hidden=true;
    item.append(label,dot);
    tab.onclick=()=>activate(tool);
    item.onclick=()=>{
      activate(tool);
      catalog.hidePopover();
      tab.focus();
    };
    shortcuts.append(tab);
    return {tool,tab,item,dots:[tab.lastElementChild,dot]};
  }

  const entries=tools.map(entry);
  if(entries.length<6){
    listing.append(...entries.map(({item})=>item));
  }else{
    for(const group of new Set(tools.map(tool=>tool.group))){
      const section=document.createElement('section');
      const heading=document.createElement('h3');
      heading.textContent=group;
      section.className='suite-catalog-group';
      section.append(heading,...entries.filter(entry=>entry.tool.group===group).map(entry=>entry.item));
      listing.append(section);
    }
  }

  const collector=initCollector({desktop,icon,toast,showLogHelp,setRunning:value=>{
    collectorRunning=value;
    showRunning();
  }});

  function activate(tool){
    if(active!==tool){
      if(active.id==='command')hideCommand();
      else if(active.id==='collector')collector.cancelPick();
    }
    active=tool;
    document.body.dataset.tool=tool.id;
    $('activeToolName').textContent=tool.name;
    for(const {tool:other,tab,item} of entries){
      const selected=other===tool;
      $(other.id+'View').hidden=!selected;
      tab.hidden=!selected&&!other.pinned;
      tab.tabIndex=selected?0:-1;
      tab.setAttribute('aria-selected',String(selected));
      if(selected)item.setAttribute('aria-current','page');
      else item.removeAttribute('aria-current');
    }
    if(tool.id==='command')showCommand();
    showRunning();
  }

  function showRunning(){
    const background=[];
    for(const {tool,tab,item,dots} of entries){
      const busy=tool.id==='command'?commandRunning:tool.id==='collector'&&collectorRunning;
      for(const dot of dots)dot.hidden=!busy;
      for(const button of [tab,item]){
        if(busy)button.setAttribute('aria-description','任务正在运行');
        else button.removeAttribute('aria-description');
      }
      if(busy&&active!==tool)background.push(tool.name);
    }
    const message=background.length?background.join('、')+'在后台运行':'';
    $('backgroundDot').hidden=!message;
    $('backgroundDot').title=message;
    if($('backgroundStatus').textContent!==message)$('backgroundStatus').textContent=message;
  }

  function filter(){
    const words=search.value.trim().toLowerCase().split(/\s+/);
    for(const {tool,item} of entries){
      const text=[tool.name,tool.english,tool.group].join(' ').toLowerCase();
      item.hidden=!words.every(word=>text.includes(word));
    }
    for(const group of listing.querySelectorAll('.suite-catalog-group')){
      group.hidden=!group.querySelector('.suite-catalog-item:not([hidden])');
    }
    $('toolCatalogEmpty').hidden=entries.some(({item})=>!item.hidden);
  }

  function step(event,visible){
    const index=visible.indexOf(event.target);
    const choices={ArrowUp:index-1,ArrowDown:index+1,Home:0,End:visible.length-1};
    if(index<0||!Object.hasOwn(choices,event.key))return null;
    event.preventDefault();
    const next=visible[(choices[event.key]+visible.length)%visible.length];
    next.focus();
    return next;
  }

  shortcuts.onkeydown=event=>step(event,entries.filter(({tab})=>!tab.hidden).map(({tab})=>tab))?.click();
  listing.onkeydown=event=>step(event,[...listing.querySelectorAll('.suite-catalog-item:not([hidden])')]);
  search.oninput=filter;
  search.onkeydown=event=>{
    const first=listing.querySelector('.suite-catalog-item:not([hidden])');
    if(!first||!['ArrowDown','Enter'].includes(event.key))return;
    event.preventDefault();
    first.focus();
    if(event.key==='Enter')first.click();
  };
  catalog.addEventListener('toggle',event=>{
    if(event.newState==='closed'&&search.value){search.value='';filter();}
  });
  desktop.onToolActivity?.(value=>{commandRunning=value.command;showRunning();});
  activate(active);
}

function formatBytes(value){
  if(value>=1048576)return (value/1048576).toFixed(1)+' MB';
  if(value>=1024)return (value/1024).toFixed(1)+' KB';
  return value.toLocaleString()+' B';
}

const stages={
  connecting:'正在连接采集引擎',unsupported:'窗口采集仅支持 Windows',unavailable:'采集引擎未连接',
  unbound:'等待选择会话',waiting:'等待会话日志',ready:'准备就绪',running:'采集中',
  saved:'采集已保存',stopped:'采集已停止','start-error':'采集未开始',
};

function initCollector({desktop,icon,toast,showLogHelp,setRunning}){
  let state={stage:desktop.logState?'connecting':'unsupported'};
  let picking=false;
  let busy=false;
  const copyMenu=$('logCopyMenu');

  function render(){
    const stage=stages[state.stage]||stages.unbound;
    const offline=['connecting','unavailable','unsupported'].includes(state.stage);
    const locked=offline||busy||picking||state.busy||state.active;
    const output=state.output||'—';
    const saved=state.lastFile||'';
    const running=Boolean(state.active);
    $('logTarget').disabled=!!locked&&!picking;
    $('logTargetTitle').textContent=state.session||'拖选会话';
    $('logTargetTitle').title=state.session||'';
    $('logTargetHint').textContent=picking?'松开绑定 · Esc 取消':'目标会话';
    $('logOutputPath').textContent=output;
    $('logOutputPath').title=state.output?'复制保存目录 · '+output:'';
    $('logOutputPath').disabled=!state.output;
    $('logOutputChange').disabled=!!locked;
    $('logAction').disabled=!!(offline||busy||picking||state.busy||(!state.canStart&&!running));
    $('logActionText').textContent=running?'停止并保存':'开始采集';
    $('logActionIcon').innerHTML=icon(running?'stop':'play');
    $('logStage').textContent=stage;
    $('logIndicator').dataset.active=String(running);
    const message=state.detail|| (state.stage==='unbound'?'将目标拖到已开启日志的 MobaXterm 会话。':'');
    $('logActivity').textContent=running?message:'';
    const bodyMessage=running?'':message;
    if($('logMessage').textContent!==bodyMessage)$('logMessage').textContent=bodyMessage;
    $('logMessage').hidden=!bodyMessage;
    $('logRetry').hidden=!state.retryable;
    $('logRetry').disabled=!!locked;
    $('logConnect').hidden=state.stage!=='unavailable';
    $('logConnect').disabled=busy;
    $('logLineCount').textContent=(state.lineCount||0).toLocaleString();
    $('logByteCount').textContent=formatBytes(state.byteCount||0);
    $('logByteCount').title=(state.byteCount||0).toLocaleString()+' 字节';
    const seconds=state.elapsedSeconds||0;
    $('logElapsed').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
    $('logSaved').hidden=!saved;
    $('logSavedName').textContent=saved.split(/[\\/]/).at(-1);
    $('logFooterIndicator').classList.toggle('running',running);
    const footer=picking?'正在拖选会话':stage;
    if($('logFooterStatus').textContent!==footer)$('logFooterStatus').textContent=footer;
    $('logFooterSession').textContent=state.session?'MobaXterm · '+state.session:'';
    setRunning(running);
  }

  function apply(value){
    if(!value||value.cancelled)return;
    state=value;
    render();
  }

  async function act(work){
    if(busy)return;
    busy=true;
    render();
    try{apply(await work());}catch(error){toast(error.message);}
    finally{busy=false;render();}
  }

  async function copy(kind,message){
    try{if(await desktop.copyLog(kind))toast(message);}
    catch(error){toast(error.message);}
  }

  async function cancelPick(){
    drag.cancel();
    if(!picking)return;
    picking=false;
    render();
    try{await desktop.cancelLogPick();}catch(error){toast(error.message);}
  }

  const drag=bindTargetDrag($('logTarget'),{
    canStart:()=>!!desktop.pickLog&&!$('logTarget').disabled&&!picking,
    onClick:showLogHelp,
    onDrag:()=>{
      picking=true;
      void act(async()=>{
        try{return await desktop.pickLog();}
        finally{picking=false;}
      });
    },
    onCancel:()=>void cancelPick(),
  });
  $('logAction').onclick=()=>void act(desktop.toggleLog);
  $('logRetry').onclick=()=>void act(desktop.retryLog);
  $('logConnect').onclick=()=>void act(desktop.connectLog);
  $('logOutputChange').onclick=()=>void act(desktop.chooseLogOutput);
  $('logOutputPath').onclick=()=>void copy('output','已复制保存目录');
  $('logSavedName').onclick=()=>void copy('filename','已复制文件名');
  $('logOpen').onclick=()=>desktop.openLog().catch(error=>toast(error.message));
  $('logSavedName').oncontextmenu=event=>{
    event.preventDefault();
    if(copyMenu.matches(':popover-open'))copyMenu.hidePopover();
    copyMenu.showPopover();
    const anchor=event.currentTarget.getBoundingClientRect();
    const point=event.clientX||event.clientY?{x:event.clientX,y:event.clientY}:{x:anchor.left,y:anchor.bottom};
    copyMenu.style.left=Math.max(4,Math.min(point.x,innerWidth-copyMenu.offsetWidth-4))+'px';
    copyMenu.style.top=Math.max(4,Math.min(point.y,innerHeight-copyMenu.offsetHeight-4))+'px';
    $('logCopyAbsolute').focus();
  };
  $('logCopyAbsolute').onclick=()=>{copyMenu.hidePopover();void copy('path','已复制绝对路径');};
  $('logCopyFilename').onclick=()=>{copyMenu.hidePopover();void copy('filename','已复制文件名');};
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&picking&&document.body.dataset.tool==='collector'){
      event.preventDefault();
      void cancelPick();
    }
  });
  desktop.onLogState?.(apply);
  desktop.logState?.().then(apply).catch(error=>toast(error.message));
  render();
  return {cancelPick};
}
