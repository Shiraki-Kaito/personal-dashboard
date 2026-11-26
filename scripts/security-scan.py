"""値を出力しない履歴・配布物の限定秘密検査。検出漏れを否定する監査ではない。"""
from pathlib import Path
import subprocess,re,sys
rules = [rb'gh[pousr]_[A-Za-z0-9]{30,}',rb'github_pat_[A-Za-z0-9_]{40,}',rb'AIza[0-9A-Za-z_-]{30,}',rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',rb'GOCSPX-[A-Za-z0-9_-]{20,}']
failures=[]; checked=0
objects=subprocess.check_output(['git','rev-list','--objects','--all']).splitlines()
batch=subprocess.Popen(['git','cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
for entry in objects:
 oid=entry.split(b' ',1)[0].decode()
 batch.stdin.write((oid+'\n').encode());batch.stdin.flush()
 header=batch.stdout.readline().split()
 if len(header)!=3:raise RuntimeError('git object read failed')
 data=batch.stdout.read(int(header[2]));batch.stdout.read(1)
 if header[1]!=b'blob':continue
 checked+=1
 if any(re.search(rule,data) for rule in rules):failures.append('history blob '+oid)
batch.stdin.close()
if batch.wait()!=0:raise RuntimeError('git scan failed')
for root in ['src','public','security']:
 for path in Path(root).rglob('*'):
  if not path.is_file():continue
  data=path.read_bytes();checked+=1
  if any(re.search(rule,data) for rule in rules):failures.append(str(path))
print('secret-pattern checks:',checked,'findings:',len(failures))
for finding in failures:print(finding)
sys.exit(bool(failures))
