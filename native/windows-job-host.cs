// Windows guardian: child is suspended until a kill-on-close Job Object owns it.
// .NET Framework 4.x, no NuGet dependencies. IPC is newline JSON; data is base64.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
class JobHost {
  const uint CREATE_SUSPENDED=4, CREATE_UNICODE_ENVIRONMENT=0x400, CREATE_NO_WINDOW=0x08000000;
  const uint STARTF_USESTDHANDLES=0x100, JOB_KILL_ON_CLOSE=0x2000;
  static IntPtr job=IntPtr.Zero, process=IntPtr.Zero;
  static readonly object outputLock=new object();
  static JavaScriptSerializer serializer=new JavaScriptSerializer { MaxJsonLength=64*1024*1024 };
  static volatile bool stopping;
  static string evidenceDir,attemptId,jobId;
  static Dictionary<string,object> evidence=new Dictionary<string,object>();
  static void Stage(string stage) {
    if(evidenceDir==null)return;
    evidence["version"]=1; evidence["attemptId"]=attemptId; evidence["jobId"]=jobId;
    evidence["stage"]=stage; evidence["updatedAt"]=DateTime.UtcNow.ToString("o");
    string target=Path.Combine(evidenceDir,"helper.json"),temp=target+"."+Guid.NewGuid().ToString("N");
    byte[] bytes=new UTF8Encoding(false).GetBytes(serializer.Serialize(evidence));
    WriteDurable(temp,bytes);
    Check(MoveFileEx(NativePath(temp),NativePath(target),1|8),"Commit supervision evidence");
  }
  // .NET Framework path APIs impose MAX_PATH even for valid v3 state paths.
  // Use extended Win32 paths and a SafeFileHandle without changing OS settings.
  static string NativePath(string value) {
    if(value.StartsWith(@"\\?\",StringComparison.Ordinal))return value;
    if(value.StartsWith(@"\\",StringComparison.Ordinal))return @"\\?\UNC\"+value.Substring(2);
    if(value.Length>=3 && Char.IsLetter(value[0]) && value[1]==':' && value[2]=='\\')return @"\\?\"+value;
    throw new ArgumentException("Guardian file paths must be absolute");
  }
  static void WriteDurable(string file,byte[] bytes) {
    using(var handle=CreateFile(NativePath(file),0x40000000,0,IntPtr.Zero,1,0x80,IntPtr.Zero)) {
      Check(!handle.IsInvalid,"Create supervision file");
      using(var stream=new FileStream(handle,FileAccess.Write,8192,false)) {stream.Write(bytes,0,bytes.Length);stream.Flush(true);}
    }
  }
  static void EmptyJob() {
    Check(TerminateJobObject(job,137),"Cleanup descendants");
    Stopwatch deadline=Stopwatch.StartNew(); ACCOUNTING account;
    do { Check(QueryInformationJobObject(job,1,out account,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero),"QueryInformationJobObject"); if(account.activeProcesses==0)break; if(deadline.ElapsedMilliseconds>10000)throw new Exception("Job descendants did not exit"); Thread.Sleep(10); }while(true);
    evidence["proof"]="job-empty";evidence["activeProcesses"]=0;Stage("job-empty");
  }
  const int PROTOCOL=2, MAX_INPUT=1024*1024, INPUT_CHUNK=32768;
  class InputFrame { public long id; public byte[] bytes; public bool eof; }
  static readonly object inputLock=new object();
  static Queue<InputFrame> inputQueue=new Queue<InputFrame>();
  static int queuedInput;
  static bool inputStopping,inputEnded;
  static FileStream inputStream;
  static Thread InputPump(IntPtr handle) {
    inputStream=new FileStream(new SafeFileHandle(handle,true),FileAccess.Write,4096,false);
    Thread thread=new Thread(()=> {
      try {
        while(true) {
          InputFrame frame;
          lock(inputLock) { while(inputQueue.Count==0 && !inputStopping)Monitor.Wait(inputLock); if(inputStopping)return; frame=inputQueue.Dequeue(); }
          if(frame.eof)inputStream.Dispose();
          else {inputStream.Write(frame.bytes,0,frame.bytes.Length);inputStream.Flush();}
          lock(inputLock)queuedInput-=frame.bytes==null?0:frame.bytes.Length;
          Emit(new {type="stdin-ack",id=frame.id});
          if(frame.eof)return;
        }
      } catch(Exception error) { if(!inputStopping&&!stopping){Emit(new {type="error",code="GUARDIAN_INPUT_FAILED",message=error.Message});Stop();} }
      finally {inputStream.Dispose();}
    });thread.IsBackground=true;thread.Start();return thread;
  }
  static void QueueInput(Dictionary<string,object> input) {
    string type=(string)input["type"];bool eof=type=="stdin-end";
    byte[] bytes=eof?null:Convert.FromBase64String((string)input["data"]);
    if(bytes!=null && bytes.Length>INPUT_CHUNK)throw new Exception("Guardian stdin frame limit");
    lock(inputLock) {
      if(inputEnded||inputStopping||queuedInput+(bytes==null?0:bytes.Length)>MAX_INPUT)throw new Exception("Guardian stdin closed or credit exceeded");
      inputEnded=eof;queuedInput+=bytes==null?0:bytes.Length;
      inputQueue.Enqueue(new InputFrame {id=Convert.ToInt64(input["id"]),bytes=bytes,eof=eof});Monitor.PulseAll(inputLock);
    }
  }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,stdin,stdout,stderr; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint activeProcessLimit; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long userTime,kernelTime,periodUser,periodKernel; public uint pageFaults,totalProcesses,activeProcesses,terminated; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h,int kind,ref EXTENDED_LIMIT info,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr h,int kind,out ACCOUNTING info,uint length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr h,IntPtr p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr h,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES attrs,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string file,uint access,uint sharing,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool MoveFileEx(string existing,string replacement,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeleteFile(string file);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string exe,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
  static void Check(bool value,string name) { if(!value) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),name); }
  static void Emit(object value) { lock(outputLock) { Console.Out.WriteLine(serializer.Serialize(value)); Console.Out.Flush(); } }
  static string Quote(string arg) {
    StringBuilder b=new StringBuilder("\""); int slashes=0;
    foreach(char c in arg) { if(c=='\\') { slashes++; continue; } if(c=='\"') { b.Append('\\',slashes*2+1); b.Append(c); } else { b.Append('\\',slashes); b.Append(c); } slashes=0; }
    b.Append('\\',slashes*2); b.Append('\"'); return b.ToString();
  }
  static Thread Pump(IntPtr handle,string type) {
    Thread t=new Thread(()=> { try { using(FileStream stream=new FileStream(new SafeFileHandle(handle,true),FileAccess.Read,8192,false)) {
      byte[] bytes=new byte[8192]; int n; while((n=stream.Read(bytes,0,bytes.Length))>0) Emit(new { type=type,data=Convert.ToBase64String(bytes,0,n) });
    }} catch(Exception e) { try { Emit(new { type="error",message="Pipe relay failed: "+e.Message }); } catch {} Stop(); } });
    t.IsBackground=true; t.Start(); return t;
  }
  static void Stop() { stopping=true; if(job!=IntPtr.Zero && !TerminateJobObject(job,137)) { try { Emit(new { type="error",message="TerminateJobObject failed",code=Marshal.GetLastWin32Error() }); } catch {} } }
  static int Main() {
    IntPtr outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,inRead=IntPtr.Zero,inWrite=IntPtr.Zero,env=IntPtr.Zero;
    PROCESS_INFORMATION pi=new PROCESS_INFORMATION(); bool assigned=false;
    IntPtr attributes=IntPtr.Zero,jobList=IntPtr.Zero,handleList=IntPtr.Zero;
    try {
      Console.OutputEncoding=new UTF8Encoding(false); Console.InputEncoding=new UTF8Encoding(false);
      Emit(new {type="hello",protocol=PROTOCOL,stdin=true});
      string line=Console.ReadLine(); if(line==null) throw new Exception("No launch request");
      Dictionary<string,object> request=serializer.Deserialize<Dictionary<string,object>>(line);
      if(!request.ContainsKey("protocol") || Convert.ToInt32(request["protocol"])!=PROTOCOL)throw new Exception("GUARDIAN_PROTOCOL_MISMATCH");
      if(request.ContainsKey("supervisionDir")) {
        evidenceDir=(string)request["supervisionDir"];attemptId=(string)request["attemptId"];jobId=(string)request["jobId"];
        var self=Process.GetCurrentProcess();evidence["helper"]=new {pid=self.Id,creationTime=self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()};
        evidence["childMayExist"]=false; Stage("helper-ready");
      }
      string exe=(string)request["command"],cwd=(string)request["cwd"];
      if(request.ContainsKey("stateDir")) {
        string stateDir=(string)request["stateDir"],probe=Path.Combine(stateDir,"guardian-write-probe-"+Guid.NewGuid().ToString("N"));
        try { WriteDurable(probe,new UTF8Encoding(false).GetBytes("guardian write preflight"));Check(DeleteFile(NativePath(probe)),"Delete guardian probe"); }
        catch(Exception error) { throw new Exception("GUARDIAN_STATE_NOT_WRITABLE: guardian cannot write the task state with its current token. No DSH process was launched. Do not auto-elevate; verify the release binary integrity label and explicit user permissions. "+error.Message); }
      }
      IEnumerable args=(IEnumerable)request["args"];
      Dictionary<string,object> vars=(Dictionary<string,object>)request["env"];
      job=CreateJobObject(IntPtr.Zero,jobId); Check(job!=IntPtr.Zero,"CreateJobObject");
      EXTENDED_LIMIT limit=new EXTENDED_LIMIT(); limit.basic.flags=JOB_KILL_ON_CLOSE;
      Check(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))),"SetInformationJobObject");
      SECURITY_ATTRIBUTES sa=new SECURITY_ATTRIBUTES(); sa.length=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); sa.inherit=1;
      Check(CreatePipe(out outRead,out outWrite,ref sa,0),"stdout pipe"); Check(SetHandleInformation(outRead,1,0),"stdout inheritance");
      Check(CreatePipe(out errRead,out errWrite,ref sa,0),"stderr pipe"); Check(SetHandleInformation(errRead,1,0),"stderr inheritance");
      Check(CreatePipe(out inRead,out inWrite,ref sa,0),"stdin pipe"); Check(SetHandleInformation(inWrite,1,0),"stdin inheritance");
      // Atomically assign the job INSIDE CreateProcess: no suspended orphan window.
      IntPtr attributeSize=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref attributeSize);
      attributes=Marshal.AllocHGlobal(attributeSize); Check(InitializeProcThreadAttributeList(attributes,2,0,ref attributeSize),"InitializeProcThreadAttributeList");
      jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,job);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"Job-list attribute unavailable (launch refused)");
      handleList=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handleList,0,inRead); Marshal.WriteIntPtr(handleList,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handleList,IntPtr.Size*2,errWrite);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"Handle-list attribute");
      STARTUPINFOEX si=new STARTUPINFOEX(); si.startup.cb=Marshal.SizeOf(typeof(STARTUPINFOEX)); si.startup.flags=STARTF_USESTDHANDLES; si.startup.stdin=inRead; si.startup.stdout=outWrite; si.startup.stderr=errWrite; si.attributes=attributes;
      StringBuilder command=new StringBuilder(Quote(exe)); foreach(object arg in args) command.Append(" "+Quote((string)arg));
      List<string> keys=new List<string>(vars.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
      StringBuilder block=new StringBuilder(); foreach(string key in keys) { if(key.IndexOf('=')>=0 || key.IndexOf('\0')>=0) throw new Exception("Invalid environment key"); block.Append(key+"="+(string)vars[key]+"\0"); } block.Append('\0');
      env=Marshal.StringToHGlobalUni(block.ToString());
      evidence["childMayExist"]=true;Stage("creating-suspended-child");
      Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW|0x80000,env,cwd,ref si,out pi),"CreateProcess suspended");
      process=pi.process;
      bool inJob; Check(IsProcessInJob(process,job,out inJob) && inJob,"Atomic job assignment verification"); assigned=true;
      var leader=Process.GetProcessById((int)pi.pid);
      evidence["child"]=new {pid=pi.pid,creationTime=leader.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()};Stage("child-created-suspended");
      Check(ResumeThread(pi.thread)!=0xffffffff,"ResumeThread");
      CloseHandle(pi.thread); pi.thread=IntPtr.Zero;
      CloseHandle(outWrite); outWrite=IntPtr.Zero; CloseHandle(errWrite); errWrite=IntPtr.Zero;
      CloseHandle(inRead); inRead=IntPtr.Zero;
      bool duplex=request.ContainsKey("duplex") && (bool)request["duplex"];
      Thread stdin=null;
      if(duplex){stdin=InputPump(inWrite);inWrite=IntPtr.Zero;}else{CloseHandle(inWrite);inWrite=IntPtr.Zero;}
      Stage("running");
      Emit(new { type="started",protocol=PROTOCOL,pid=pi.pid,supervision="windows-job-kill-on-close" });
      Thread stdout=Pump(outRead,"stdout"); outRead=IntPtr.Zero;
      Thread stderr=Pump(errRead,"stderr"); errRead=IntPtr.Zero;
      Thread control=new Thread(()=> { try {
        string message;
        while((message=Console.ReadLine())!=null) {
          if(message.Length>65536)throw new Exception("Guardian control frame limit");
          Dictionary<string,object> controlInput=serializer.Deserialize<Dictionary<string,object>>(message);
          string type=(string)controlInput["type"];
          if(type=="kill"){Stop();return;}
          if(duplex && (type=="stdin"||type=="stdin-end"))QueueInput(controlInput);
          else throw new Exception("Unknown guardian control frame");
        }
        Stop();
      }catch(Exception error){Emit(new {type="error",code="GUARDIAN_INPUT_FAILED",message=error.Message});Stop();} });control.IsBackground=true;control.Start();
      Check(WaitForSingleObject(process,0xffffffff)==0,"WaitForSingleObject"); uint code; Check(GetExitCodeProcess(process,out code),"GetExitCodeProcess");
      // A settled leader is not sufficient: force any lingering descendants and confirm an empty job.
      evidence["exitCode"]=unchecked((int)code); EmptyJob();
      lock(inputLock){inputStopping=true;Monitor.PulseAll(inputLock);}
      if(stdin!=null && !stdin.Join(5000))throw new Exception("Stdin relay did not finish");
      if(!stdout.Join(5000) || !stderr.Join(5000)) throw new Exception("Pipe relay did not finish");
      Emit(new { type="exit",code=unchecked((int)code),terminated=stopping,treeExited=true }); return 0;
    } catch(Exception e) {
      bool confirmed=false;
      try {
        evidence["firstError"]=e.Message;
        if(pi.process==IntPtr.Zero) {evidence["childMayExist"]=false;evidence["proof"]="not-started";evidence["exitCode"]=1;Stage("not-started");confirmed=true;}
        else if(assigned) { evidence["exitCode"]=1;EmptyJob();confirmed=true; }
        else {Check(TerminateProcess(pi.process,137),"Terminate unassigned child");Check(WaitForSingleObject(pi.process,10000)==0,"Wait unassigned child");evidence["exitCode"]=1;EmptyJob();confirmed=true;}
      } catch(Exception cleanup) {try{evidence["cleanupError"]=cleanup.Message;Stage("exit-unconfirmed");}catch{} }
      try { Emit(new { type="error",message=e.Message,code=e.Message.StartsWith("GUARDIAN_STATE_NOT_WRITABLE")?"GUARDIAN_STATE_NOT_WRITABLE":"GUARDIAN_LAUNCH_FAILED" });Emit(new {type="exit",code=1,treeExited=confirmed,launchRefused=pi.process==IntPtr.Zero}); }catch{}
      return 1;
    }
    finally {
      if(pi.process!=IntPtr.Zero && !assigned) TerminateProcess(pi.process,137);
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(attributes!=IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
      if(jobList!=IntPtr.Zero) Marshal.FreeHGlobal(jobList); if(handleList!=IntPtr.Zero) Marshal.FreeHGlobal(handleList);
      foreach(IntPtr handle in new IntPtr[] { pi.thread,pi.process,outRead,outWrite,errRead,errWrite,inRead,inWrite,env }) {
        if(handle==IntPtr.Zero) continue; if(handle==env) Marshal.FreeHGlobal(handle); else CloseHandle(handle);
      }
    }
  }
}
