' Launches Agent Desktop with no visible console window - WScript.Shell.Run's
' third argument (0 = hidden window, False = don't wait for exit) hides the
' npm/cmd wrapper. Electron's own window is a real GUI window regardless of
' whether the console that launched it is hidden, so this only hides the
' console, not the app itself.

' 2026-09-27: added stderr capture after the app vanished with zero evidence
' anywhere - no Electron exit-trace event (before-quit/will-quit/render-
' process-gone/child-process-gone/uncaughtExceptionMonitor, added in v1.59.6
' for this exact prior incident), no Windows crash/hang event, no Crashpad
' dump, no reboot, ExecutionTimeLimit on the launcher task ruled out (PT0S =
' unlimited). Since stdout/stderr from the hidden "npm start" wrapper were
' never captured anywhere, a fatal error that prints to stderr and kills the
' process before any Electron handler runs (e.g. a Node "JavaScript heap out
' of memory" abort, or an unhandled promise rejection - Node's default for
' one of those with no listener is to print to stderr and terminate,
' invisibly to every hook above) would be invisible - exactly the kind of
' gap that would explain "no evidence either way" twice. Only stderr is
' captured (not stdout) to keep this small - npm/electron's routine stdout
' chatter isn't worth the size, but a fatal abort's stack trace goes to
' stderr. Simple size-based rotation (one .old backup) keeps it from growing
' unbounded across a long-running session.
' Log lives under %APPDATA%\agent-desktop\logs (the same folder Electron's
' own heartbeat.json/stuck-turn-watchdog.log already use), NOT under this
' Dropbox-synced source folder - a first attempt that wrote here hit
' "Permission denied" from the classic VBScript FileSystemObject while
' Dropbox's own sync/placeholder handling had the just-created file locked,
' which is exactly the class of intermittent D:\ file-lock error this
' project already flags Controlled Folder Access and Dropbox sync for.
' 2026-09-27, reviewed same day: the block below is entirely best-effort. It
' had no error handling at all on first write, which independently confirmed
' review findings called out as the worse bug - CreateFolder only creates one
' path segment (not mkdir -p), so a truly fresh profile where
' %APPDATA%\agent-desktop itself doesn't exist yet (Electron normally creates
' it on the app's own first run, not guaranteed to pre-exist before this
' launcher ever runs) would throw "Path not found" with no On Error Resume
' Next anywhere in the file - aborting the whole script before the actual
' `objShell.Run` line and silently preventing Agent Desktop from starting at
' all. That is strictly worse than the zero-evidence disappearance this
' logging was added to diagnose. Diagnostics must never be able to block the
' one thing this script exists to do, so every step from here down is wrapped
' to guarantee the launch always happens - logPath is left empty on any
' failure, and the app starts either way, with or without stderr capture.
On Error Resume Next

Set objShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set envProcess = objShell.Environment("PROCESS")
envProcess("PATH") = "C:\Program Files\nodejs;" & envProcess("PATH")

objShell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)

logPath = ""
appDataDir = objShell.ExpandEnvironmentStrings("%APPDATA%")
agentDesktopDir = appDataDir & "\agent-desktop"
logsDir = agentDesktopDir & "\logs"
' Each CreateFolder call only makes one segment - build the path one level at
' a time instead of assuming the parent already exists.
If Not fso.FolderExists(agentDesktopDir) Then fso.CreateFolder(agentDesktopDir)
If Not fso.FolderExists(logsDir) Then fso.CreateFolder(logsDir)

If fso.FolderExists(logsDir) Then
    candidateLogPath = logsDir & "\crash-stderr.log"
    oldLogPath = logsDir & "\crash-stderr.old.log"

    ' Rotation only runs here, at launch - not continuously during a single
    ' long-running session (Iddo routinely runs this app for days without
    ' restarting), so a session that generates a lot of stderr chatter
    ' between launches can still grow past 5MB before the next rotation.
    ' Good enough for its actual purpose (bounding growth across restarts,
    ' not within one), not a live cap.
    If fso.FileExists(candidateLogPath) Then
        If fso.GetFile(candidateLogPath).Size > 5 * 1024 * 1024 Then
            If fso.FileExists(oldLogPath) Then fso.DeleteFile oldLogPath, True
            fso.MoveFile candidateLogPath, oldLogPath
        End If
    End If

    Set logFile = fso.OpenTextFile(candidateLogPath, 8, True) ' 8 = ForAppending, create if missing
    If Err.Number = 0 Then
        logFile.WriteLine "=== launch " & Now() & " ==="
        logFile.Close
        If Err.Number = 0 Then logPath = candidateLogPath
    End If
    Err.Clear
End If

If logPath <> "" Then
    objShell.Run "cmd.exe /c npm start 2>> """ & logPath & """", 0, False
Else
    ' Logging setup failed (locked file, permissions, first-run race, or
    ' anything else) - launch without stderr capture rather than not at all.
    objShell.Run "cmd.exe /c npm start", 0, False
End If
