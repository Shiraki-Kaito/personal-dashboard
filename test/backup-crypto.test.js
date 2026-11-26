import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptBackup,decryptBackup,maximumPlaintextBytes} from '../public/backup-crypto.js';
const passphrase='架空試験専用・長いフレーズ・0123456789';
test('日本語バックアップを暗号化・復号し、同じ内容でもsaltとIVが変わる',async()=>{
  const plaintext=JSON.stringify({title:'検証用報告',email:'fixture@example.test'});
  const first=await encryptBackup(plaintext,passphrase),second=await encryptBackup(plaintext,passphrase);
  assert.notEqual(first.iv,second.iv);assert.notEqual(first.salt,second.salt);
  assert.equal(JSON.stringify(first).includes('fixture@example.test'),false);
  assert.equal(await decryptBackup(first,passphrase),plaintext);
  assert.equal(await decryptBackup(second,passphrase),plaintext);
});
test('誤パスフレーズ・暗号文/ヘッダーの改変・過大KDFを拒否する',async()=>{
  const value=await encryptBackup('{}',passphrase);
  await assert.rejects(decryptBackup(value,'別の架空試験専用フレーズ0123456789'),/復号できません/);
  const changed={...value,ciphertext:(value.ciphertext[0]==='A'?'B':'A')+value.ciphertext.slice(1)};
  await assert.rejects(decryptBackup(changed,passphrase),/復号できません/);
  for(const changes of [{version:2},{iterations:2**31},{salt:'AA=='},{iv:''},{cipher:'AES-CBC'},{unknown:'x'}])await assert.rejects(decryptBackup({...value,...changes},passphrase));
  await assert.rejects(encryptBackup('{}','short'));
});
test('UTF8実バイト上限と最大サイズの復号を確認する',async()=>{
  const plaintext='a'.repeat(maximumPlaintextBytes);
  const encrypted=await encryptBackup(plaintext,passphrase);
  assert.equal((await decryptBackup(encrypted,passphrase)).length,maximumPlaintextBytes);
  await assert.rejects(encryptBackup(plaintext+'あ',passphrase),/8MiB/);
});
