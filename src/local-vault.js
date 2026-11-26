/* Local save encryption: AES-256-GCM with a non-exportable key stored in IndexedDB. */
(function(){
 "use strict";
 var DB_NAME="fishjoy_local_vault_v1",STORE="keys",KEY_ID="save-key",PREFIX="FJ1:";
 function openDb(){
  return new Promise(function(resolve,reject){
   if(!window.indexedDB){reject(new Error("IndexedDB is unavailable"));return;}
   var req=indexedDB.open(DB_NAME,1);
   req.onupgradeneeded=function(){if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE);};
   req.onsuccess=function(){resolve(req.result);};
   req.onerror=function(){reject(req.error||new Error("IndexedDB open failed"));};
  });
 }
 var keyPromise=null;
 function getKey(){
  if(keyPromise)return keyPromise;
  keyPromise=openDb().then(function(db){return new Promise(function(resolve,reject){
   var tx=db.transaction(STORE,"readonly"),req=tx.objectStore(STORE).get(KEY_ID);
   req.onsuccess=function(){var key=req.result;if(key){resolve(key);return;}
    if(!window.crypto||!crypto.subtle){reject(new Error("WebCrypto is unavailable"));return;}
    crypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]).then(function(created){
     var write=db.transaction(STORE,"readwrite"),put=write.objectStore(STORE).put(created,KEY_ID);
     put.onsuccess=function(){resolve(created);};put.onerror=function(){reject(put.error||new Error("Key storage failed"));};
    }).catch(reject);
   };
   req.onerror=function(){reject(req.error||new Error("Key read failed"));};
  });}).catch(function(err){keyPromise=null;throw err;});
  return keyPromise;
 }
 function encode(bytes){var s="";for(var i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);return btoa(s);}
 function decode(value){var s=atob(value),out=new Uint8Array(s.length);for(var i=0;i<s.length;i++)out[i]=s.charCodeAt(i);return out;}
 function encrypt(value){
  return getKey().then(function(key){
   var iv=crypto.getRandomValues(new Uint8Array(12)),plain=new TextEncoder().encode(JSON.stringify(value));
   return crypto.subtle.encrypt({name:"AES-GCM",iv:iv},key,plain).then(function(cipher){
    return PREFIX+JSON.stringify({v:1,iv:encode(iv),data:encode(new Uint8Array(cipher))});
   });
  });
 }
 function decrypt(raw){
  var envelope=JSON.parse(raw.slice(PREFIX.length));
  if(!envelope||envelope.v!==1||!envelope.iv||!envelope.data)throw new Error("Unsupported encrypted save format");
  return getKey().then(function(key){
   return crypto.subtle.decrypt({name:"AES-GCM",iv:decode(envelope.iv)},key,decode(envelope.data));
  }).then(function(plain){return JSON.parse(new TextDecoder().decode(plain));});
 }
 window.FishJoyVault={
  read:function(storageKey){
   var raw;try{raw=localStorage.getItem(storageKey);}catch(e){return Promise.reject(e);}
   if(raw===null)return Promise.resolve(null);
   if(raw.indexOf(PREFIX)===0)return decrypt(raw);
   var legacy;try{legacy=JSON.parse(raw);}catch(e){return Promise.reject(new Error("Legacy save JSON is invalid"));}
   if(!legacy||typeof legacy!=="object")return Promise.resolve(null);
   // Migrate only after successful encryption; keep original value if encryption fails.
   return encrypt(legacy).then(function(encrypted){localStorage.setItem(storageKey,encrypted);return legacy;});
  },
  write:function(storageKey,value){
   return encrypt(value).then(function(encrypted){localStorage.setItem(storageKey,encrypted);return true;});
  }
 };
})();