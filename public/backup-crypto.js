// Web Cryptoの認証付き暗号を使用。パスフレーズはネットワーク・Storageへ送らない。
export const maximumPlaintextBytes = 8 * 1024 * 1024;
export const maximumEncryptedBytes = 12 * 1024 * 1024;
const iterations = 600_000;
const format = 'personal-dashboard-encrypted-backup';
const encoder = new TextEncoder();
const authenticatedHeader = encoder.encode(format + ':1:PBKDF2-SHA256:600000:AES-256-GCM');
function encode(bytes) {
  let value='';
  for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(value);
}
function decode(value, limit) {
  if(typeof value!=='string' || value.length>Math.ceil(limit/3)*4 || value.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('暗号化ファイルの形式が不正です');
  const bytes=Uint8Array.from(atob(value),character=>character.charCodeAt(0));
  if(bytes.length>limit)throw Error('暗号化ファイルが上限を超えています');
  return bytes;
}
async function deriveKey(passphrase,salt) {
  if(typeof passphrase!=='string' || [...passphrase].length<16 || passphrase.length>1024)throw Error('パスフレーズは16文字以上1024文字以内で入力してください');
  const material=await crypto.subtle.importKey('raw',encoder.encode(passphrase),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encryptBackup(plaintext,passphrase) {
  const bytes=encoder.encode(plaintext);
  if(bytes.length>maximumPlaintextBytes)throw Error('バックアップの上限8MiBを超えています');
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await deriveKey(passphrase,salt);
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:authenticatedHeader,tagLength:128},key,bytes);
  return {format,version:1,kdf:'PBKDF2-SHA256',iterations,cipher:'AES-256-GCM',salt:encode(salt),iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))};
}
export function isEncryptedBackup(value) {return value?.format===format;}
export async function decryptBackup(envelope,passphrase) {
  const keys=['format','version','kdf','iterations','cipher','salt','iv','ciphertext'];
  if(!isEncryptedBackup(envelope) || envelope.version!==1 || envelope.kdf!=='PBKDF2-SHA256' || envelope.iterations!==iterations || envelope.cipher!=='AES-256-GCM' || Object.keys(envelope).some(key=>!keys.includes(key)))throw Error('対応していない暗号化ファイルです');
  const salt=decode(envelope.salt,16),iv=decode(envelope.iv,12),ciphertext=decode(envelope.ciphertext,maximumPlaintextBytes+16);
  if(salt.length!==16 || iv.length!==12 || ciphertext.length<16)throw Error('暗号化ファイルの形式が不正です');
  const key=await deriveKey(passphrase,salt);
  try {
    const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:authenticatedHeader,tagLength:128},key,ciphertext);
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  } catch {throw Error('復号できません。パスフレーズの相違、またはファイルの破損・改変が考えられます');}
}
