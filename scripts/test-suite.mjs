import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const {_electron:electron}=require('playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const installed=process.argv[2];
const temp=await mkdtemp(path.join(os.tmpdir(),'tools-workbench-'));
const profile=path.join(temp,'profile');
const evidence=path.join(root,'test-output','suite');
const source=path.join(temp,'台架巡检.txt');
let desktop;
try{
  await mkdir(profile,{recursive:true});
  await mkdir(evidence,{recursive:true});
  await writeFile(source,'[设备信息]\r\necho "设备状态"\r\n\r\n[接口]\r\necho "检查"\r\n');
  await writeFile(path.join(profile,'session.json'),JSON.stringify({paths:[source],active:source}));
  desktop=await electron.launch({
    executablePath:installed||require('electron'),
    args:[...(installed?[]:[root]),'--user-data-dir='+profile],
    timeout:30000,
  });
  const page=await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const command=page.getByRole('tab',{name:'命令定向'});
  const collector=page.getByRole('tab',{name:'日志采集'});
  const editor=page.locator('#editor');
  await command.waitFor();
  await page.waitForFunction(()=>document.querySelector('#fileName').textContent==='台架巡检.txt');
  assert.match(await editor.inputValue(),/echo "设备状态"/);
  assert.equal(await page.locator('.suite-rail').evaluate(el=>el.getBoundingClientRect().width),52);
  const selected=await editor.evaluate(el=>{
    const start=el.value.indexOf('设备状态');
    el.setSelectionRange(start,start+4);
    el.dispatchEvent(new Event('select',{bubbles:true}));
    return [el.selectionStart,el.selectionEnd];
  });
  await page.screenshot({path:path.join(evidence,'command.png')});
  await collector.click();
  const expected=process.platform==='win32'?'等待选择会话':'窗口采集仅支持 Windows';
  await page.waitForFunction(stage=>document.querySelector('#logStage').textContent===stage,expected);
  assert.equal(await page.locator('#logAction').isDisabled(),true);
  if(process.platform==='win32'){
    assert.equal(await page.locator('#logTarget').isEnabled(),true);
    assert.match(await page.locator('#logOutputPath').textContent(),/LogCollector$/);
  }
  await page.screenshot({path:path.join(evidence,'collector.png')});
  await page.locator('#helpButton').click();
  await page.getByRole('dialog',{name:'采集指定会话的日志'}).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#toolCatalogButton').click();
  const search=page.getByRole('searchbox',{name:'搜索工具'});
  await search.fill('cmd send');
  await search.press('Enter');
  await editor.waitFor({state:'visible'});
  assert.deepEqual(await editor.evaluate(el=>[el.selectionStart,el.selectionEnd]),selected);
  await command.focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await collector.getAttribute('aria-selected'),'true');
  const initial=await page.locator('#pinButton').getAttribute('aria-pressed');
  await page.locator('#pinButton').click();
  await page.waitForFunction(before=>document.querySelector('#pinButton').getAttribute('aria-pressed')!==before,initial);
  await page.locator('#pinButton').click();
  assert.deepEqual(errors,[]);
  await page.locator('#closeWindow').click();
  await new Promise((resolve,reject)=>{
    const process=desktop.process();
    if(process.exitCode!==null){resolve();return;}
    const timer=setTimeout(()=>reject(new Error('窗口关闭超时')),10000);
    process.once('exit',()=>{clearTimeout(timer);resolve();});
  });
  console.log('Tool switching, editor selection, tool directory, log engine startup, pin and app exit passed.');
}finally{
  if(desktop&&desktop.process().exitCode===null)await desktop.close();
  await rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:200});
}
