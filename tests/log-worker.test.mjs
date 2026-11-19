import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
import {setImmediate} from 'node:timers/promises';

const require=createRequire(import.meta.url);
const {LogWorker,workerCommand}=require('../electron/log-worker.cjs');
function fixture(){
  const child=new EventEmitter();
  for(const name of ['stdout','stderr','stdin'])child[name]=new PassThrough();
  const worker=new LogWorker({command:{file:'worker',args:[]},config:'capture.json',launch:()=>child});
  worker.connect();
  return {worker,child};
}

test('collector IPC keeps request results distinct from polling updates',async()=>{
  const {worker,child}=fixture();
  const request=worker.request('bind',{handle:'9223372036854775807',x:-300,y:20});
  assert.equal(worker.busy,true);
  assert.deepEqual(JSON.parse(child.stdin.read()),{id:1,operation:'bind',value:{handle:'9223372036854775807',x:-300,y:20}});
  child.stdout.write('{"state":{"stage":"running","active":true,"busy":false}}\n');
  child.stdout.write('{"id":1,"ok":true,"state":{"stage":"saved","active":false,"busy":false}}\n');
  assert.equal((await request).stage,'saved');
  assert.equal(worker.busy,false);
  worker.close();
});

test('collector IPC rejects a crash and makes reconnect available',async()=>{
  const {worker,child}=fixture();
  const request=worker.request('stop');
  const unavailable=once(worker,'state');
  child.emit('close',1,null);
  await assert.rejects(request,/无法启动/);
  assert.equal((await unavailable)[0].stage,'unavailable');
  assert.equal(worker.state.active,false);
  assert.equal(worker.busy,false);
  await setImmediate();
});

test('the packaged collector never launches a system Python interpreter',()=>{
  const command=workerCommand({packaged:true,resources:'/app/resources',root:'/app',python:'wrong'});
  assert.match(command.file,/log-worker[\\/]LogCaptureWorker\.exe$/);
  assert.deepEqual(command.args,[]);
});
