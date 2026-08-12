package local.codenode.config;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/** Small Windows Credential Manager bridge. Secrets never appear in a process argument. */
public final class WindowsCredentialStore {
    private static final String SCRIPT = """
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
 public UInt32 Flags; public UInt32 Type; public IntPtr TargetName; public IntPtr Comment;
 public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize;
 public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes;
 public IntPtr TargetAlias; public IntPtr UserName;
}
public static class NativeCredential {
 [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref CREDENTIAL c, UInt32 flags);
 [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr c);
 [DllImport("Advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
 [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr c);
 public static bool Write(string target, string user, string value) {
  IntPtr t=Marshal.StringToCoTaskMemUni(target), u=Marshal.StringToCoTaskMemUni(user), b=Marshal.StringToCoTaskMemUni(value);
  try { CREDENTIAL c=new CREDENTIAL(); c.Type=1; c.TargetName=t; c.UserName=u; c.CredentialBlob=b; c.CredentialBlobSize=(UInt32)(value.Length*2); c.Persist=2; return CredWrite(ref c,0); }
  finally { Marshal.FreeCoTaskMem(t); Marshal.FreeCoTaskMem(u); Marshal.FreeCoTaskMem(b); }
 }
 public static string Read(string target) {
  IntPtr p; if(!CredRead(target,1,0,out p)) return null;
  try { CREDENTIAL c=Marshal.PtrToStructure<CREDENTIAL>(p); if(c.CredentialBlob==IntPtr.Zero) return ""; return Marshal.PtrToStringUni(c.CredentialBlob,(int)c.CredentialBlobSize/2); }
  finally { CredFree(p); }
 }
 public static bool Delete(string target) { return CredDelete(target,1,0); }
}
'@
$target = [Console]::ReadLine()
$mode = [Console]::ReadLine()
$secret = [Console]::In.ReadToEnd()
if ($mode -eq 'read') { $v=[NativeCredential]::Read($target); if ($null -ne $v) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)) } }
elseif ($mode -eq 'write') { if ([NativeCredential]::Write($target,'CodeNode',$secret)) { 'OK' } else { 'ERR' } }
elseif ($mode -eq 'delete') { if ([NativeCredential]::Delete($target)) { 'OK' } else { 'ERR' } }
""";

    public boolean available() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }

    public Optional<String> read(String target) {
        String output = run(target, "read", "");
        if (output.isBlank()) return Optional.empty();
        try { return Optional.of(new String(Base64.getDecoder().decode(output), StandardCharsets.UTF_8)); }
        catch (IllegalArgumentException ignored) { return Optional.empty(); }
    }

    public boolean write(String target, String secret) {
        return "OK".equals(run(target, "write", secret).trim());
    }

    public boolean delete(String target) {
        return "OK".equals(run(target, "delete", "").trim());
    }

    private String run(String target, String mode, String secret) {
        if (!available() || target == null || target.isBlank()) return "";
        try {
            Process process = new ProcessBuilder("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", SCRIPT)
                    .redirectErrorStream(true).start();
            try (OutputStream out = process.getOutputStream()) {
                out.write((target + "\n" + mode + "\n").getBytes(StandardCharsets.UTF_8));
                if (secret != null) out.write(secret.getBytes(StandardCharsets.UTF_8));
            }
            if (!process.waitFor(8, TimeUnit.SECONDS)) { process.destroyForcibly(); return ""; }
            return new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        } catch (IOException | InterruptedException e) {
            Thread.currentThread().interrupt();
            return "";
        }
    }

    public static String targetFor(String apiBase) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest((apiBase == null ? "" : apiBase).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) hex.append(String.format("%02x", b));
            return "CodeNode/Agent/" + hex.substring(0, 24);
        } catch (Exception e) { return "CodeNode/Agent/default"; }
    }
}
