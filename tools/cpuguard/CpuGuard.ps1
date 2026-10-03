<#
CPUGUARD_VERSION=2.1
CpuGuard v2.1 - keeps this PC usable while the agent fleet works.
(Iddo, 2026-10-03: all agents were told "go" at once, CPU hit 100%, he could not move the mouse.
 His brief: tell a short 100% spike from a sustained slowdown; when it is sustained, find which
 agent(s) cause it and slow THEM down - split the load, do not stop all work.)

Shipped inside Agent Desktop (tools\cpuguard). Portable: all state lives under -StateDir (default
%APPDATA%\agent-desktop\cpuguard); no admin rights; nothing outside the agent processes is touched.

Runs endlessly as a hidden per-user scheduled task, independent of Agent Desktop. Samples every 2 s using
fast native calls (the CIM/.NET Process APIs took 0.3 s per process on a loaded PC).

  PREVENTION (always): every Claude CLI process + everything it launches runs at BELOW NORMAL priority
     on all logical cores except the last $ReserveCores (kept free for the mouse, Explorer, Premiere...).
  SPIKE: CPU >= $HotPct% for less than $SustainSecs s is ignored (counted in the log only).
  SUSTAINED = in the last $SustainSecs s at least 80% of samples had CPU >= $HotPct%, or free RAM < $MemFreePct%.
     1. DIAGNOSE: 3 s per-process CPU + memory measurement, grouped per agent session (each agent = one
        process tree under the Claude daemon). Labelled with the agent's project folder. Also measures how much
        of the load is NOT the agents (Premiere, Dropbox, Defender...): if that is the main cause, it is
        reported and the agents are left alone.
     2. SPLIT: the culprit agents (biggest users, together >= 60% of agent load) go to IDLE priority and are
        confined to a shared 4-core "penalty box" ($PenaltyCores cores): they keep working, only slower, and
        cannot take more than 4 cores in total. All other agents keep full speed.
     3. STILL hot after $EscalateSecs s: the culprits' helper processes (find, node, python, ffmpeg - never
        claude.exe itself, so no API connection is cut) are duty-cycled: paused part of every 2 s tick
        (50%, then 75%).
     4. STILL hot after $HoldAfterSecs s: writes the STOP CODE  state\fleet_hold.json  = "do not START new
        agent work until it disappears" (for Agent Desktop / Optimization / agents to honour).
     5. RELEASE: once CPU < $CoolPct% for $CoolSecs s, culprits are let out of the box ONE AT A TIME every
        $ReadmitSecs s (staggered re-admission); one that makes it hot again goes straight back (strike counted).
  Every episode writes incidents\cpu_<time>.txt (who, how much, what they were running) and a
  notification (max one per 10 min). status.json is always current (for ARGUS / the daily report).
  A paused process is always resumed: suspended pids are kept in state\suspended.json and released on
  start-up, on exit and by -Mode Release.

Never touches electron.exe (Agent Desktop) or Claude Desktop, never pauses a claude.exe.
Modes: Run (default) | Status | Release (resume everything, clear hold, restore priorities)
Test:  -RootName <exe>  treats processes of that exe name as the agent roots.
#>
param(
    [ValidateSet('Run','Status','Release')] [string]$Mode = 'Run',
    [string]$StateDir = '',
    [int]$ReserveCores = 0, [int]$PenaltyCores = 0,   # 0 = auto: scale with the core count (see below)
    [int]$HotPct = 85, [int]$SustainSecs = 20, [int]$MemFreePct = 8,
    [int]$EscalateSecs = 20, [int]$HoldAfterSecs = 60,
    [int]$CoolPct = 70, [int]$CoolSecs = 30, [int]$ReadmitSecs = 20,
    [string]$RootName = 'claude.exe',
    [switch]$Notify
)
$ErrorActionPreference = 'Continue'
if (-not $StateDir) { $StateDir = Join-Path $env:APPDATA 'agent-desktop\cpuguard' }
$work = $StateDir
$stDir = Join-Path $work 'state'; $incDir = Join-Path $work 'incidents'
New-Item -ItemType Directory -Force $stDir, $incDir | Out-Null
$logF = Join-Path $work 'cpuguard.log'; $holdF = Join-Path $stDir 'fleet_hold.json'
$statF = Join-Path $stDir 'status.json'; $suspF = Join-Path $stDir 'suspended.json'

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Collections.Generic; using System.Text;
public static class Cg {
    [DllImport("kernel32.dll")] public static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PE e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PE e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool SetPriorityClass(IntPtr h, uint cls);
    [DllImport("kernel32.dll")] static extern bool SetProcessAffinityMask(IntPtr h, UIntPtr mask);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder sb, ref uint size);
    [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr h, out PMC c, uint size);
    [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MS m);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PE { public uint size, usage, pid; public IntPtr heap; public uint module, threads, ppid; public int pri; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
    [StructLayout(LayoutKind.Sequential)] struct PMC { public uint cb, PageFaultCount; public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage; }
    [StructLayout(LayoutKind.Sequential)] struct MS { public uint len, load; public ulong totalPhys, availPhys, totalPage, availPage, totalVirt, availVirt, availExt; }
    const uint ACC = 0x1E10; // set_info | query_limited | suspend_resume | query_info | vm_read
    public static List<string> Snapshot() {
        var r = new List<string>(); IntPtr h = CreateToolhelp32Snapshot(2, 0); if (h == (IntPtr)(-1)) return r;
        PE e = new PE(); e.size = (uint)Marshal.SizeOf(typeof(PE));
        for (bool ok = Process32FirstW(h, ref e); ok; ok = Process32NextW(h, ref e)) r.Add(e.pid + "|" + e.ppid + "|" + e.exe);
        CloseHandle(h); return r;
    }
    public static bool SetPrio(int pid, uint cls) { IntPtr h = OpenProcess(ACC, false, pid); if (h == IntPtr.Zero) return false; bool ok = SetPriorityClass(h, cls); CloseHandle(h); return ok; }
    public static bool SetAff(int pid, long mask) { IntPtr h = OpenProcess(ACC, false, pid); if (h == IntPtr.Zero) return false; bool ok = SetProcessAffinityMask(h, (UIntPtr)(ulong)mask); CloseHandle(h); return ok; }
    public static long CpuTicks(int pid) { IntPtr h = OpenProcess(ACC, false, pid); if (h == IntPtr.Zero) return -1; long c, e, k, u; long r = GetProcessTimes(h, out c, out e, out k, out u) ? k + u : -1; CloseHandle(h); return r; }
    public static long WorkingSet(int pid) { IntPtr h = OpenProcess(ACC, false, pid); if (h == IntPtr.Zero) return 0; PMC c; c.cb = (uint)Marshal.SizeOf(typeof(PMC)); long r = GetProcessMemoryInfo(h, out c, c.cb) ? (long)(ulong)c.WorkingSetSize : 0; CloseHandle(h); return r; }
    public static string Image(int pid) { IntPtr h = OpenProcess(ACC, false, pid); if (h == IntPtr.Zero) return ""; var sb = new StringBuilder(1024); uint n = 1024; string r = QueryFullProcessImageNameW(h, 0, sb, ref n) ? sb.ToString() : ""; CloseHandle(h); return r; }
    public static bool Suspend(int pid) { IntPtr h = OpenProcess(ACC, false, pid); if (h == IntPtr.Zero) return false; bool ok = NtSuspendProcess(h) == 0; CloseHandle(h); return ok; }
    public static bool Resume(int pid) { IntPtr h = OpenProcess(ACC, false, pid); if (h == IntPtr.Zero) return false; bool ok = NtResumeProcess(h) == 0; CloseHandle(h); return ok; }
    public static double FreeMemPct() { MS m = new MS(); m.len = (uint)Marshal.SizeOf(typeof(MS)); return GlobalMemoryStatusEx(ref m) ? 100.0 * m.availPhys / m.totalPhys : 100; }
}
'@
$IDLE = 0x40; $BELOW = 0x4000; $NORMAL = 0x20

function Log($m) { try { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content $logF -Encoding utf8 -ErrorAction Stop } catch {}
    if ((Get-Item $logF -ErrorAction SilentlyContinue).Length -gt 2MB) { Move-Item $logF "$logF.old" -Force } }

function Resume-All {
    if (Test-Path $suspF) { try { foreach ($id in @(Get-Content $suspF -Raw | ConvertFrom-Json)) { [void][Cg]::Resume([int]$id) } } catch {}; Remove-Item $suspF -ErrorAction SilentlyContinue }
}

if ($Mode -eq 'Release') {
    Resume-All; Remove-Item $holdF -ErrorAction SilentlyContinue
    foreach ($line in [Cg]::Snapshot()) { $f = $line.Split('|',3); if ($f[2] -ieq $RootName) { } }
    'resumed paused processes, hold cleared (priorities return to BelowNormal on the next CpuGuard tick)'; return
}
if ($Mode -eq 'Status') { if (Test-Path $statF) { Get-Content $statF -Raw } else { 'not running' }; if (Test-Path $holdF) { 'HOLD ACTIVE:'; Get-Content $holdF -Raw }; return }

$cores = [Environment]::ProcessorCount
# Small machines (<= 8 logical cores, e.g. a laptop): keep 1-2 cores free and use a 2-core penalty box;
# the 4+4 defaults only make sense on big workstations.
if ($ReserveCores -le 0) { $ReserveCores = if ($cores -le 4) { 1 } elseif ($cores -le 8) { 2 } elseif ($cores -le 16) { 3 } else { 4 } }
if ($PenaltyCores -le 0) { $PenaltyCores = if ($cores -le 8) { 2 } else { 4 } }
if ($ReserveCores -ge $cores) { $ReserveCores = [Math]::Max(0, $cores - 1) }
$nAllowed = $cores - $ReserveCores
if ($PenaltyCores -gt $nAllowed) { $PenaltyCores = [Math]::Max(1, $nAllowed) }
$allowMask = [int64]((1L -shl $nAllowed) - 1)
$boxMask   = [int64]($allowMask -band (-bnot ((1L -shl ($nAllowed - $PenaltyCores)) - 1)))
$script:lastTimes = $null
function Get-CpuPct {
    $i=0L;$k=0L;$u=0L; [void][Cg]::GetSystemTimes([ref]$i,[ref]$k,[ref]$u); $r = 0
    if ($script:lastTimes) { $di=$i-$script:lastTimes[0]; $dtt=($k+$u)-($script:lastTimes[1]+$script:lastTimes[2]); if ($dtt -gt 0) { $r = [int](100*($dtt-$di)/$dtt) } }
    $script:lastTimes = @($i,$k,$u); $r
}

# ---- process tree / agent grouping -------------------------------------------------------------
$script:isCli = @{}      # pid -> bool, claude.exe not under WindowsApps
$script:cmd   = @{}      # pid -> command line of claude.exe processes (refreshed when new pids appear)
function Update-Cmdlines($pids) {
    $need = @($pids | Where-Object { -not $script:cmd.ContainsKey($_) }); if (-not $need) { return }
    try { Get-CimInstance Win32_Process -Filter "Name='$RootName'" -Property ProcessId,CommandLine | ForEach-Object { $script:cmd[[int]$_.ProcessId] = [string]$_.CommandLine } } catch {}
    foreach ($p in $need) { if (-not $script:cmd.ContainsKey($p)) { $script:cmd[$p] = '' } }
}
function Get-Fleet {
    $name = @{}; $par = @{}; $kids = @{}
    foreach ($line in [Cg]::Snapshot()) { $f = $line.Split('|',3); $id=[int]$f[0]; $pp=[int]$f[1]; $name[$id]=$f[2]; $par[$id]=$pp
        if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.ArrayList }; [void]$kids[$pp].Add($id) }
    foreach ($k in @($script:isCli.Keys)) { if (-not $name.ContainsKey($k)) { $script:isCli.Remove($k); $script:cmd.Remove($k) } }
    $tree = @{}; $stack = New-Object System.Collections.Stack
    foreach ($id in @($name.Keys)) { if ($name[$id] -ieq $RootName) {
        if (-not $script:isCli.ContainsKey($id)) { $script:isCli[$id] = if ($RootName -ieq 'claude.exe') { [Cg]::Image($id) -notmatch 'WindowsApps' } else { $true } }
        if ($script:isCli[$id]) { $tree[$id] = 1; $stack.Push($id) } } }
    while ($stack.Count) { $id = $stack.Pop(); if ($kids.ContainsKey($id)) { foreach ($c in $kids[$id]) { if (-not $tree.ContainsKey($c) -and $name[$c] -notmatch '^(electron|Claude)\.exe$') { $tree[$c] = 1; $stack.Push($c) } } } }
    Update-Cmdlines @($tree.Keys | Where-Object { $name[$_] -ieq $RootName })
    # group = the topmost RootName ancestor-or-self that is not the daemon itself (daemon -> one pty-host per agent session)
    $group = @{}
    foreach ($id in @($tree.Keys)) {
        $g = $null; $cur = $id; $guard = 0
        while ($cur -and $tree.ContainsKey($cur) -and $guard++ -lt 12) {
            if ($name[$cur] -ieq $RootName -and ([string]$script:cmd[$cur]) -notmatch 'daemon run') { $g = $cur }
            $cur = $par[$cur] }
        if ($g) { $group[$id] = $g } elseif ($name[$id] -ieq $RootName) { $group[$id] = $id }   # the daemon itself: its own group
    }
    return @{ name = $name; group = $group; tree = $tree }
}

$script:labelCache = @{}
function Get-Label($rootPid, $fleet) {
    if ($script:labelCache.ContainsKey($rootPid)) { return $script:labelCache[$rootPid] }
    $lab = "session pid $rootPid"
    foreach ($m in $fleet.group.Keys) { if ($fleet.group[$m] -eq $rootPid) {
        $c = [string]$script:cmd[$m]
        if ($c -match '--bg-pty-host') { continue }   # the first process of a session is the pty host; the real session has the id
        if ($c -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') {
            $hit = Get-ChildItem (Join-Path $env:USERPROFILE '.claude\projects') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName "$($Matches[1]).jsonl") } | Select-Object -First 1
            if ($hit) { $lab = ($hit.Name -replace '-+claude-session$','' -replace '^[A-Za-z]--',''); $lab = ($lab -split '--')[-1] -replace '-',' '; $lab = $lab.Trim(); if (-not $lab) { $lab = 'agent session' }; break } } } }
    $script:labelCache[$rootPid] = $lab; return $lab
}

# ---- state ---------------------------------------------------------------------------------------
$boxed = @{}          # group root pid -> @{ since; strikes; label }
$strikes = @{}        # group root pid -> count
$prio = @{}           # pid -> last class we set (avoid redundant calls)
$suspendedNow = @{}   # pid -> 1
function Save-Susp { if ($suspendedNow.Count) { @($suspendedNow.Keys) | ConvertTo-Json | Set-Content $suspF -Encoding utf8 } else { Remove-Item $suspF -ErrorAction SilentlyContinue } }
function Apply-Class($fleet) {
    $n = 0
    foreach ($id in @($fleet.tree.Keys)) {
        $g = $fleet.group[$id]; $inBox = ($g -and $boxed.ContainsKey($g))
        $want = if ($inBox) { 'box' } else { 'base' }
        if ($prio[$id] -eq $want) { continue }
        if ($inBox) { [void][Cg]::SetPrio($id, $IDLE); [void][Cg]::SetAff($id, $boxMask) } else { [void][Cg]::SetPrio($id, $BELOW); [void][Cg]::SetAff($id, $allowMask) }
        $prio[$id] = $want; $n++
    }
    foreach ($id in @($prio.Keys)) { if (-not $fleet.tree.ContainsKey($id)) { $prio.Remove($id) } }
    return $n
}
function Notify($title, $text) { if (-not $Notify) { return }; try { & msg.exe * /TIME:300 "$title - $text" 2>$null } catch {} }   # off by default: Agent Desktop shows its own banner

function Measure-Load($fleet, $secs = 3) {
    $a = @{}; foreach ($id in $fleet.name.Keys) { $t = [Cg]::CpuTicks($id); if ($t -ge 0) { $a[$id] = $t } }
    Start-Sleep $secs
    $fleet2 = $fleet; $per = @{}; $outside = @{}
    $den = $secs * 1e7 * $cores
    foreach ($id in $a.Keys) { $t = [Cg]::CpuTicks($id); if ($t -lt 0) { continue }; $d = ($t - $a[$id]) / $den * 100
        if ($d -le 0.05) { continue }
        if ($fleet.group.ContainsKey($id)) { $g = $fleet.group[$id]; $per[$g] = [double]$per[$g] + $d }
        else { $outside[$id] = $d } }
    $mem = @{}; foreach ($id in $fleet.group.Keys) { $g = $fleet.group[$id]; $mem[$g] = [double]$mem[$g] + [Cg]::WorkingSet($id) / 1MB }
    return @{ per = $per; outside = $outside; mem = $mem }
}

function Write-Incident($fleet, $m, $reason) {
    $f = Join-Path $incDir ("cpu_{0}.txt" -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
    $agentTot = ($m.per.Values | Measure-Object -Sum).Sum; $outTot = ($m.outside.Values | Measure-Object -Sum).Sum
    $lines = @("CpuGuard incident - $reason", "time $(Get-Date -Format s)   cores $cores   free RAM $([int][Cg]::FreeMemPct())%", '',
        ('Agents use {0:N1}% of the machine, everything else {1:N1}%' -f $agentTot, $outTot), '', 'Agent sessions by CPU (3 s sample, % of whole machine) and memory:')
    foreach ($g in ($m.per.Keys | Sort-Object { -$m.per[$_] } | Select-Object -First 12)) {
        $lines += ('  {0,5:N1}%  {1,6:N0} MB  {2}  (root pid {3}){4}' -f $m.per[$g], $m.mem[$g], (Get-Label $g $fleet), $g, $(if ($boxed.ContainsKey($g)) { '  <- penalty box' } else { '' })) }
    $lines += ''; $lines += 'Biggest NON-agent CPU users:'
    $top = @($m.outside.Keys | Sort-Object { -$m.outside[$_] } | Select-Object -First 6)
    foreach ($id in $top) { $lines += ('  {0,5:N1}%  {1} (pid {2})' -f $m.outside[$id], $fleet.name[$id], $id) }
    $lines | Set-Content $f -Encoding utf8; return $f
}

# ---- main loop -----------------------------------------------------------------------------------
Resume-All
Log "CpuGuard v2.1 started: cores=$cores allowed=0..$($nAllowed-1) penalty-box mask=0x$('{0:X}' -f $boxMask) hot>=$HotPct% sustained=$SustainSecs s"
[void](Get-CpuPct)
$hist = New-Object System.Collections.ArrayList     # recent samples @(time, cpu, memFree)
$sw = [Diagnostics.Stopwatch]::StartNew(); $lastT = 0.0; $tick = 99.0; $fleet = $null
$episode = $false; $episodeStart = 0.0; $cool = 0.0; $lastNotify = [datetime]::MinValue; $lastAdmit = 0.0
$lastDiag = -99.0; $holdOn = $false; $duty = 0; $spikes = 0; $spikeRun = 0.0; $iter = 0
try {
while ($true) { try {
    Start-Sleep 2
    $now = $sw.Elapsed.TotalSeconds; $dt = $now - $lastT; $lastT = $now; $iter++
    $cpu = Get-CpuPct; $free = [Cg]::FreeMemPct()
    [void]$hist.Add(@($now, $cpu, $free)); while ($hist.Count -gt 0 -and ($now - $hist[0][0]) -gt $SustainSecs) { $hist.RemoveAt(0) }
    $tick += $dt
    if ($tick -ge 10 -or -not $fleet) { $tick = 0; $fleet = Get-Fleet; $n = Apply-Class $fleet; if ($n) { Log "classes applied to $n process(es); agent tree = $($fleet.tree.Count)" } }

    # spike vs sustained
    $span = if ($hist.Count) { $now - $hist[0][0] } else { 0 }
    $hotN = @($hist | Where-Object { $_[1] -ge $HotPct }).Count; $memN = @($hist | Where-Object { $_[2] -lt $MemFreePct }).Count
    $full = ($span -ge ($SustainSecs - 3))
    $sustainedCpu = $full -and $hist.Count -gt 0 -and ($hotN / $hist.Count) -ge 0.8
    $sustainedMem = $full -and $hist.Count -gt 0 -and ($memN / $hist.Count) -ge 0.8
    if ($cpu -ge $HotPct) { $spikeRun += $dt } else { if ($spikeRun -ge 4 -and -not $episode) { $spikes++; Log ("spike ignored: {0:N0} s at >= {1}% (spike count today {2})" -f $spikeRun, $HotPct, $spikes) }; $spikeRun = 0 }

    if (($sustainedCpu -or $sustainedMem) -and -not $episode) {
        $episode = $true; $episodeStart = $now; $cool = 0; $lastAdmit = $now
        $why = if ($sustainedCpu -and $sustainedMem) { "CPU>=$HotPct% and free RAM<$MemFreePct% for ~$SustainSecs s" } elseif ($sustainedCpu) { "CPU>=$HotPct% for ~$SustainSecs s (not a spike)" } else { "free RAM<$MemFreePct% for ~$SustainSecs s" }
        Log "SUSTAINED: $why"; $script:why = $why
    }
    if ($episode) {
        $age = $now - $episodeStart
        $hotNow = ($cpu -ge $HotPct) -or ($free -lt $MemFreePct)
        # (re)diagnose every 15 s while hot and decide who goes in the box
        if ($hotNow -and ($now - $lastDiag) -ge 15) {
            $lastDiag = $now; $fleet = Get-Fleet
            $m = Measure-Load $fleet 3
            $agentTot = ($m.per.Values | Measure-Object -Sum).Sum; $outTot = ($m.outside.Values | Measure-Object -Sum).Sum
            $f = Write-Incident $fleet $m $script:why
            if ($outTot -gt 1.5 * $agentTot -and -not $sustainedMem) {
                Log ("diagnosis: NON-agent load {0:N0}% vs agents {1:N0}% - agents left alone. {2}" -f $outTot, $agentTot, $f)
            } else {
                $acc = 0; $added = @()
                $byLoad = if ($sustainedMem -and -not $sustainedCpu) { $m.mem.Keys | Sort-Object { -$m.mem[$_] } } else { $m.per.Keys | Sort-Object { -$m.per[$_] } }
                foreach ($g in $byLoad) {
                    if (($m.per[$g] -lt 2) -and -not ($sustainedMem -and $m.mem[$g] -gt 2000)) { break }
                    if (-not $boxed.ContainsKey($g)) { $boxed[$g] = @{ since = $now; label = (Get-Label $g $fleet) }; $strikes[$g] = 1 + [int]$strikes[$g]; $added += "$($boxed[$g].label) ($('{0:N1}' -f $m.per[$g])% cpu, $('{0:N0}' -f $m.mem[$g]) MB)" }
                    $acc += $m.per[$g]; if ($agentTot -gt 0 -and $acc -ge 0.6 * $agentTot -and $boxed.Count -ge 1) { break }
                    if ($boxed.Count -ge 6) { break } }
                $n = Apply-Class $fleet
                if ($added) { Log "SPLIT: penalty box += $($added -join '; '). $f"
                    if (((Get-Date) - $lastNotify).TotalMinutes -ge 10) { Notify 'PC overloaded - agents slowed' "Sustained load. Slowed: $($added -join ', '). Others keep working. Details: $f"; $lastNotify = Get-Date } }
            }
        }
        # duty-cycle the culprits' helper processes after $EscalateSecs, stop-code after $HoldAfterSecs
        $duty = 0; if ($hotNow -and $age -ge $EscalateSecs -and $boxed.Count) { $duty = if ($age -ge 2 * $EscalateSecs) { 3 } else { 2 } }
        foreach ($id in @($suspendedNow.Keys)) { [void][Cg]::Resume($id); $suspendedNow.Remove($id) }   # always resume first each tick
        if ($duty -gt 0 -and ($iter % 4) -lt $duty) {   # duty 2 -> paused 2 of 4 ticks (50%), 3 -> 75%
            foreach ($id in @($fleet.tree.Keys)) { $g = $fleet.group[$id]; $nm = $fleet.name[$id]
                if ($g -and $boxed.ContainsKey($g) -and $nm -notmatch '^(claude|conhost|OpenConsole|electron)\.exe$') { if ([Cg]::Suspend($id)) { $suspendedNow[$id] = 1 } } } }
        Save-Susp
        if ($hotNow -and $age -ge $HoldAfterSecs -and -not $holdOn) {
            $holdOn = $true
            @{ hold = $true; since = (Get-Date -Format s); reason = $script:why; boxed = @($boxed.Values | ForEach-Object { $_.label }); note = 'Do not START new agent work until this file disappears (CpuGuard removes it ~30 s after load is back under control).' } | ConvertTo-Json | Set-Content $holdF -Encoding utf8
            Log "STOP CODE: fleet_hold.json written (still overloaded after $HoldAfterSecs s of throttling)"
            Notify 'PC still overloaded' "Fleet HOLD set: no new agent work until it clears. Slowed: $((@($boxed.Values | ForEach-Object { $_.label })) -join ', ')" }
        # cool-down and staggered re-admission
        if ($cpu -lt $CoolPct -and $free -ge $MemFreePct) { $cool += $dt } else { $cool = 0 }
        if ($cool -ge $CoolSecs) {
            if ($holdOn) { Remove-Item $holdF -ErrorAction SilentlyContinue; $holdOn = $false; Log 'hold cleared' }
            if ($boxed.Count -and ($now - $lastAdmit) -ge $ReadmitSecs) {
                $g = @($boxed.Keys | Sort-Object { $boxed[$_].since })[0]; Log "re-admit: $($boxed[$g].label) leaves the penalty box (strike $($strikes[$g]))"; $boxed.Remove($g); $lastAdmit = $now; [void](Apply-Class $fleet) }
            if (-not $boxed.Count) { $episode = $false; $lastDiag = -99; Log ("episode over after {0:N0} s" -f ($now - $episodeStart)) }
        }
    }
    @{ at = (Get-Date -Format s); cpu = $cpu; freeRamPct = [int]$free; episode = $episode; boxed = @($boxed.Values | ForEach-Object { $_.label }); hold = (Test-Path $holdF); agentProcs = $(if ($fleet) { $fleet.tree.Count } else { 0 }); spikesIgnored = $spikes } | ConvertTo-Json | ForEach-Object { try { Set-Content $statF $_ -Encoding utf8 -ErrorAction Stop } catch {} }
} catch { Log "loop error: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)" }
}
} finally { foreach ($id in @($suspendedNow.Keys)) { [void][Cg]::Resume($id) }; Remove-Item $suspF -ErrorAction SilentlyContinue; Log 'CpuGuard stopped (all paused processes resumed)' }
