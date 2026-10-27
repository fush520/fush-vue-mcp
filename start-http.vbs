' Fush MCP - start the HTTP-mode server, silently, in the background.
'
' Why this exists: V4.9+ defaults to HTTP mode. One long-lived server is shared by
' every AI client session, so you do not end up with several competing processes.
'
' Usage: double-click this file.
' Log:    temp\http-server.log   (next to this script)
' Stop:   end the node process in Task Manager  (or: taskkill /IM node.exe -- make
'         sure no OTHER node process is running first)
'
' NOTE ON ENCODING: this file is deliberately ASCII-only. It used to carry GBK
' comments, which render as mojibake in any editor assuming UTF-8. Keeping it
' ASCII means it reads the same under every code page.
'
' NOTE ON PATHS: the script locates itself via WScript.ScriptFullName, so it works
' from wherever the project folder happens to live. It must not hardcode a
' directory -- an earlier version shipped the author's own absolute path, which
' silently broke this fallback launcher for everyone else.

Option Explicit

Dim fso, here, serverDir, logFile, cmd, shell
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
serverDir = fso.BuildPath(here, "mcp-server")
logFile = fso.BuildPath(fso.BuildPath(here, "temp"), "http-server.log")

If Not fso.FolderExists(serverDir) Then
    MsgBox "Cannot find the mcp-server folder next to this script:" & vbCrLf & serverDir, 16, "Fush MCP"
    WScript.Quit 1
End If
If Not fso.FileExists(fso.BuildPath(serverDir, "dist\index.js")) Then
    MsgBox "dist\index.js is missing -- build it first:" & vbCrLf & vbCrLf & _
           "    cd mcp-server" & vbCrLf & "    npm install" & vbCrLf & "    npm run build", 16, "Fush MCP"
    WScript.Quit 1
End If

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = serverDir
cmd = "cmd /c node dist\index.js --http > """ & logFile & """ 2>&1"
shell.Run cmd, 0, False
