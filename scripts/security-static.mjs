import {execFileSync} from 'node:child_process';
import {readdirSync,readFileSync} from 'node:fs';
let checked=0;
for (const folder of ['src','public','frontend','scripts']) {
 for(const name of readdirSync(folder).filter(name=>/\.(m?js)$/.test(name))) {
  const path=folder+'/'+name;
  execFileSync(process.execPath,['--check',path],{stdio:'pipe'});
  if(folder==='src' && /\beval\s*\(|new\s+Function\s*\(/.test(readFileSync(path,'utf8'))) throw Error('Dynamic code execution: '+path);
  checked++;
 }
}
console.log('Syntax + limited execution-sink rules:',checked,'files passed');
