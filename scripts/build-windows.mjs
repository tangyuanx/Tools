import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Build on Windows x64.');
const root=fileURLToPath(new URL('../',import.meta.url));
const python=process.env.TOOLS_PYTHON||'py';
const pythonArgs=process.env.TOOLS_PYTHON?[]:['-3.12'];
function run(file,args){
  const child=spawnSync(file,args,{cwd:root,stdio:'inherit',windowsHide:true});
  if(child.error)throw child.error;
  if(child.status!==0)throw new Error(file+' exited '+child.status);
}

const build=path.join(root,'build');
fs.mkdirSync(build,{recursive:true});
run(python,[...pythonArgs,'-m','PyInstaller','--noconfirm','--clean','--noupx','--onedir','--console',
  '--name','LogCaptureWorker','--distpath',path.join(build,'log-worker'),
  '--workpath',path.join(build,'pyinstaller'),'--specpath',build,path.join(root,'collector','worker.py')]);
run(process.execPath,[path.join(root,'node_modules','electron-builder','cli.js'),'--win','nsis','--x64','--publish','never']);
