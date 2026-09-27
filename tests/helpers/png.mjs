// Builds valid solid-colour PNG files for tests and the dev agent.
import {deflateSync} from 'node:zlib';

function crc32(buffer){let crc=0xffffffff;for(const byte of buffer){crc^=byte;for(let k=0;k<8;k++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}return (crc^0xffffffff)>>>0;}
function chunk(type,data){const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,'ascii'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([length,body,crc]);}

export function makePng(width,height,[r,g,b]=[30,69,251]){
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const row=Buffer.alloc(1+width*3);for(let x=0;x<width;x++){row[1+x*3]=r;row[2+x*3]=g;row[3+x*3]=b;}
 const raw=Buffer.concat(Array.from({length:height},()=>row));
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
