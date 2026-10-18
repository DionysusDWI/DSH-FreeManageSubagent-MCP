/** Local synthetic CLI: exercises actual guardian duplex transport; never loads DSH or a model. */
import {syntheticSdk} from './synthetic-sdk.mjs';
const size=process.env.SYNTHETIC_ANSWER;
const runtime=syntheticSdk({env:process.env,emit:bytes=>{
  // Deliberately split multibyte UTF-8 and large frames across pipe writes.
  for(let offset=0;offset<bytes.length;offset+=4093)process.stdout.write(bytes.subarray(offset,offset+4093));
},stderr:bytes=>process.stderr.write(bytes),settings:{missingTurn:size==='missing',unpersisted:size==='unpersisted',
  answer:size==='large'?'SYNTHETIC_COMPLETE:'+'ёж✓'.repeat(20000):'SYNTHETIC_COMPLETE'},
onShutdown:()=>{process.stdin.pause();process.stdin.destroy();}});
process.stdin.on('data',bytes=>runtime.write(bytes));
process.stdin.on('end',()=>runtime.stop());
