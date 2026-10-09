param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [int]$ProcessId = 0
)

# Read only the target process' window properties/icons. Never writes Shell properties.
$taskExePath = [IO.Path]::GetFullPath($ExecutablePath)
$taskOutputPath = [IO.Path]::GetFullPath($OutputDirectory)
if (-not [IO.Directory]::Exists($taskOutputPath)) { throw 'Create an owned output directory before inspection.' }
$taskProcessIds = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $taskExePath -and ($ProcessId -eq 0 -or $_.ProcessId -eq $ProcessId) } | ForEach-Object { [int]$_.ProcessId })
if ($taskProcessIds.Count -eq 0) { throw 'The target executable is not running.' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class HakobiWindowInspection {
  [StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid FormatId; public uint Id; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] public struct PropertyValue {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public IntPtr Pointer;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface PropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropertyValue value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropertyValue value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr handle, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out PropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropertyValue value);
  delegate bool EnumCallback(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);

  static string Read(PropertyStore store, uint id) {
    var key = new PropertyKey { FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = id };
    PropertyValue value;
    int result = store.GetValue(ref key, out value);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
    try { return value.Type == 31 ? Marshal.PtrToStringUni(value.Pointer) : "<VT=" + value.Type + ">"; }
    finally { PropVariantClear(ref value); }
  }
  public static object[] Inspect(int[] processIds, string directory) {
    var ids = new HashSet<int>(processIds);
    var windows = new List<object>();
    EnumWindows(delegate(IntPtr handle, IntPtr parameter) {
      uint pid;
      GetWindowThreadProcessId(handle, out pid);
      if (!ids.Contains((int)pid)) return true;
      var title = new StringBuilder(2048);
      GetWindowText(handle, title, title.Capacity);
      var details = new Dictionary<string, object> {
        { "Handle", handle.ToInt64() }, { "ProcessId", pid }, { "Title", title.ToString() }, { "Visible", IsWindowVisible(handle) }
      };
      PropertyStore store = null;
      try {
        var iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
        int result = SHGetPropertyStoreForWindow(handle, ref iid, out store);
        if (result < 0) Marshal.ThrowExceptionForHR(result);
        details["AppId"] = Read(store, 5);
        details["RelaunchCommand"] = Read(store, 2);
        details["RelaunchIconResource"] = Read(store, 3);
        details["RelaunchDisplayName"] = Read(store, 4);
      } catch (Exception error) { details["PropertyError"] = error.Message; }
      finally { if (store != null) Marshal.ReleaseComObject(store); }
      for (uint size = 0; size <= 2; size++) {
        UIntPtr icon;
        // WM_GETICON: reads the existing icon handle; never destroys that user-owned handle.
        if (SendMessageTimeout(handle, 0x7F, new UIntPtr(size), IntPtr.Zero, 2, 500, out icon) == IntPtr.Zero || icon == UIntPtr.Zero) continue;
        var name = handle.ToInt64() + "-icon-" + size + ".png";
        using (var clone = (Icon)Icon.FromHandle(new IntPtr(unchecked((long)icon.ToUInt64()))).Clone())
        using (var bitmap = clone.ToBitmap()) { bitmap.Save(Path.Combine(directory, name), ImageFormat.Png); }
        details["WindowIcon" + size] = name;
      }
      windows.Add(details);
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
}
'@ -ReferencedAssemblies System.Drawing

[HakobiWindowInspection]::Inspect([int[]]$taskProcessIds, $taskOutputPath) | ConvertTo-Json -Depth 4
