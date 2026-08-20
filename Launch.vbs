' Launches Agent Desktop with no visible console window - WScript.Shell.Run's
' third argument (0 = hidden window, False = don't wait for exit) hides the
' npm/cmd wrapper. Electron's own window is a real GUI window regardless of
' whether the console that launched it is hidden, so this only hides the
' console, not the app itself.

Set objShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set envProcess = objShell.Environment("PROCESS")
envProcess("PATH") = "C:\Program Files\nodejs;" & envProcess("PATH")

objShell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
objShell.Run "cmd.exe /c npm start", 0, False
