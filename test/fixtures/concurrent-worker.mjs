import { acquireWorkspaceLock } from '../../lib/workspace-lock.js';
import { ReportQueue } from '../../lib/report-queue.js';
import { appendGuidance,appendChannelRecord,createChannel } from '../../dsh-plugin/channel.js';
let release;
process.on('message',async msg=> {
 try {
  if(msg.type==='lock') {process.send({type:'waiting'});release=await acquireWorkspaceLock({...msg,signal:new AbortController().signal});process.send({type:'acquired',pid:process.pid});}
  if(msg.type==='release') {release?.();release=null;process.send({type:'released'});process.disconnect();}
  if(msg.type==='reports') {const q=new ReportQueue({conversationKey:msg.owner.conversationKey,logPath:msg.logPath});createChannel(msg.channel,msg.owner);for(let i=0;i<msg.count;i++){q.push({taskId:msg.owner.taskId,eventId:process.pid+':'+i,text:'same',agentId:'a-'+process.pid,data:{i}});appendChannelRecord(msg.channel,{type:'report',eventId:process.pid+':'+i,text:'shard '+i});}process.send({type:'done'});process.disconnect();}
  if(msg.type==='guidance') {for(let i=0;i<msg.count;i++)appendGuidance(msg.channel,'writer '+process.pid+' message '+i);process.send({type:'done'});process.disconnect();}
 }catch(error){process.send({type:'error',message:error.message});process.exitCode=1;process.disconnect();}
});
process.on('disconnect',()=>{if(release)release();});
