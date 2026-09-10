/* Encrypted local persistence for sensitive user settings.
 * The AES-GCM key is non-extractable and stored by the browser in IndexedDB;
 * localStorage intentionally never receives plaintext rules or credentials. */
(() => {
  const DB='btc-indicator-secure-vault-v1', STORE='vault', KEY='aes-gcm-key';
  const open=()=>new Promise((resolve,reject)=>{const request=indexedDB.open(DB,1);request.onupgradeneeded=()=>request.result.createObjectStore(STORE);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
  const transaction=async(mode,fn)=>{const db=await open();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,mode), store=tx.objectStore(STORE), request=fn(store);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);tx.onerror=()=>reject(tx.error)})}finally{db.close()}};
  const getKey=async()=>{let key=await transaction('readonly',store=>store.get(KEY));if(key)return key;key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);await transaction('readwrite',store=>store.put(key,KEY));return key};
  const put=async(name,value)=>{const iv=crypto.getRandomValues(new Uint8Array(12)),plain=new TextEncoder().encode(JSON.stringify(value)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(`btc-vault:${name}:v1`)},await getKey(),plain);await transaction('readwrite',store=>store.put({version:1,iv:[...iv],cipher:[...new Uint8Array(cipher)]},`data:${name}`))};
  const get=async name=>{const row=await transaction('readonly',store=>store.get(`data:${name}`));if(!row)return null;try{const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(row.iv),additionalData:new TextEncoder().encode(`btc-vault:${name}:v1`)},await getKey(),new Uint8Array(row.cipher));return JSON.parse(new TextDecoder().decode(plain))}catch{throw new Error('本机加密副本无法验证，已拒绝读取。')}};
  const remove=async name=>transaction('readwrite',store=>store.delete(`data:${name}`));
  window.btcSecureVault={put,get,remove};
})();
