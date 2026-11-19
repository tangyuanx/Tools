'use strict';
const {EventEmitter}=require('node:events');
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const path=require('node:path');

const unavailable='采集引擎无法启动，请检查安装或重试。';

function workerCommand({packaged,resources,root,python=process.env.TOOLS_PYTHON}){
  if(packaged)return {file:path.join(resources,'log-worker','LogCaptureWorker.exe'),args:[]};
  const script=path.join(root,'collector','worker.py');
  if(python)return {file:python,args:['-u',script]};
  return {file:'py',args:['-3.12','-u',script]};
}

class LogWorker extends EventEmitter{
  constructor({command,config,launch=spawn}){
    super();
    Object.assign(this,{command,config,launch});
    this.pending=new Map();
    this.sequence=0;
    this.child=null;
    this.closed=false;
    this.state={stage:command?'connecting':'unsupported',active:false,busy:false};
  }

  get busy(){return this.pending.size>0||this.state.busy;}

  update(state){
    this.state=state;
    this.emit('state',this.state);
  }

  connect(){
    if(!this.command||this.closed||this.child)return;
    this.update({stage:'connecting',active:false,busy:false});
    const child=this.launch(this.command.file,[...this.command.args,'--config',this.config],{
      windowsHide:true,stdio:['pipe','pipe','pipe'],
    });
    this.child=child;
    child.stderr.resume();
    child.stdin.on('error',()=>this.disconnected(child));
    child.on('error',()=>this.disconnected(child));
    child.once('close',()=>this.disconnected(child));
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      if(this.child!==child)return;
      try{this.receive(JSON.parse(line));}
      catch{
        child.stdin.end();
        this.disconnected(child);
      }
    });
  }

  receive(packet){
    if(!Object.hasOwn(packet,'id')){
      if(packet.state)this.update(packet.state);
      return;
    }
    const request=this.pending.get(packet.id);
    if(!request)return;
    this.pending.delete(packet.id);
    if(!packet.ok){request.reject(new Error(packet.error||unavailable));return;}
    if(packet.state)this.update(packet.state);
    request.resolve(this.state);
  }

  disconnected(child){
    if(this.child!==child)return;
    this.child=null;
    child.stdin.end();
    for(const {reject} of this.pending.values())reject(new Error(unavailable));
    this.pending.clear();
    if(!this.closed)this.update({...this.state,stage:'unavailable',active:false,busy:false,canStart:false,detail:unavailable});
  }

  request(operation,value){
    if(!this.child||this.closed)return Promise.reject(new Error(unavailable));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      this.child.stdin.write(JSON.stringify({id,operation,value})+'\n');
    });
  }

  close(){
    this.closed=true;
    this.child?.stdin.end();
  }
}

module.exports={LogWorker,workerCommand};
