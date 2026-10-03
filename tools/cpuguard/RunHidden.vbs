' Launches PowerShell with no console window (WScript.Shell.Run style 0) and WAITS for it, so a scheduled
' task running this stays 'Running' while the script runs (and Task Scheduler can restart it on failure).
' Usage: wscript.exe //B RunHidden.vbs CpuGuard.ps1 [args for CpuGuard.ps1 ...]
' The first argument is the PowerShell script (relative paths are resolved next to this file).
Option Explicit
Dim sh, fso, here, script, args, i, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count < 1 Then WScript.Quit 2
script = WScript.Arguments(0)
If Not fso.FileExists(script) Then script = fso.BuildPath(here, script)
args = ""
For i = 1 To WScript.Arguments.Count - 1
  args = args & " " & Chr(34) & WScript.Arguments(i) & Chr(34)
Next
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & script & Chr(34) & args
WScript.Quit sh.Run(cmd, 0, True)
