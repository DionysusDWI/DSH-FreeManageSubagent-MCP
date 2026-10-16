/** Local process identities. PID absence alone never proves an entire tree exited. */
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
export function powershell(script) {
  const run=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:4*1024*1024});
  if(run.error||run.status!==0) throw Object.assign(new Error('OS identity query unavailable'),{code:'IDENTITY_UNVERIFIED'});
  return JSON.parse(run.stdout.trim());
}
export function processIdentity(pid) {
  if(!Number.isSafeInteger(pid)||pid<1) return {pid,status:'unknown'};
  try {
    if(process.platform==='win32') return powershell(`try { $p=Get-Process -Id ${pid} -ErrorAction Stop; @{pid=${pid};status='alive';creationTime=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}|ConvertTo-Json -Compress } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { @{pid=${pid};status='absent'}|ConvertTo-Json -Compress }`);
    const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
    return {pid,status:fields[0]==='Z'?'absent':'alive',creationTime:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+fields[19]};
  } catch(error) {return {pid,status:error.code==='ENOENT'?'absent':'unknown'};}
}
export function identityStatus(identity) {
  const current=processIdentity(identity.pid);
  if(current.status!=='alive')return {...current,match:null};
  if(!identity.creationTime||!current.creationTime)return {...current,status:'unknown',match:null};
  return {...current,match:identity.creationTime===current.creationTime,status:identity.creationTime===current.creationTime?'alive':'reused'};
}
export function physicalPath(configured) {
  try {
    if(process.platform!=='win32')return {configured,physical:fs.realpathSync.native(configured),verifiedBy:'realpath'};
    const literal="'"+configured.replaceAll("'","''")+"'";
    const cs=`using System; using System.Text; using System.Runtime.InteropServices;
public class DshPath {
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string p,uint a,uint s,IntPtr x,uint d,uint f,IntPtr t);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr h,StringBuilder b,uint n,uint f);
[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
public static string Resolve(string p) { var h=CreateFile(p,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero); if(h==new IntPtr(-1))throw new Exception(); try { var b=new StringBuilder(32768); var n=GetFinalPathNameByHandle(h,b,32768,0); if(n==0||n>=32768)throw new Exception(); return b.ToString(); } finally { CloseHandle(h); } }
}`;
    const value=powershell(`Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(cs).toString('base64')}'))); [DshPath]::Resolve(${literal})|ConvertTo-Json -Compress`);
    return {configured,physical:value.replace(/^\\\\\?\\/,'').replace(/^UNC\\/,'\\\\'),verifiedBy:'GetFinalPathNameByHandle'};
  } catch {return {configured,physical:null,verifiedBy:null,reason:'OS path resolution unavailable'};}
}
export function relevantProcesses(workspace,taskDir) {
  if(process.platform!=='win32')return {verified:false,processes:[],reason:'Operator process inventory is only supported on Windows'};
  try {
    const rows=powershell('Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress');
    if(!rows)return {verified:false,processes:[],reason:'Empty process inventory'};
    const needles=[workspace,taskDir].map(s=>s.toLowerCase());
    return {verified:true,processes:[rows].flat().filter(p=>p.ProcessId!==process.pid&&p.CommandLine&&needles.some(n=>p.CommandLine.toLowerCase().includes(n))).map(p=>({pid:p.ProcessId}))};
  }catch{return {verified:false,processes:[],reason:'OS process inventory unavailable'};}
}
