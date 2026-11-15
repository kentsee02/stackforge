using System;
using System.IO;
using System.Runtime.InteropServices;

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IRecycleShellItem {}

// The unused declarations preserve the order of the Windows COM vtable.
[ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IRecycleFileOperation {
    void Advise();
    void Unadvise();
    void SetOperationFlags(uint flags);
    void SetProgressMessage();
    void SetProgressDialog();
    void SetProperties();
    void SetOwnerWindow();
    void ApplyPropertiesToItem();
    void ApplyPropertiesToItems();
    void RenameItem();
    void RenameItems();
    void MoveItem();
    void MoveItems();
    void CopyItem();
    void CopyItems();
    void DeleteItem(IRecycleShellItem item, IntPtr progressSink);
    void DeleteItems();
    void NewItem();
    void PerformOperations();
    void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
}

public static class StackForgeRecycle {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern int SHCreateItemFromParsingName(string path, IntPtr bindContext, ref Guid interfaceId, out IRecycleShellItem item);

    public static void Move(string path) {
        if (new DriveInfo(Path.GetPathRoot(path)).DriveType != DriveType.Fixed)
            throw new IOException("A local fixed drive is required for the Recycle Bin.");

        Guid shellItem = typeof(IRecycleShellItem).GUID;
        IRecycleShellItem item;
        Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path, IntPtr.Zero, ref shellItem, out item));
        var operation = (IRecycleFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
        try {
            const uint recycle = 0x00080000, earlyFailure = 0x00100000, addUndoRecord = 0x20000000;
            const uint noErrorUi = 0x0400, silent = 0x0004;
            operation.SetOperationFlags(recycle | earlyFailure | addUndoRecord | noErrorUi | silent);
            operation.DeleteItem(item, IntPtr.Zero);
            operation.PerformOperations();
            bool aborted;
            operation.GetAnyOperationsAborted(out aborted);
            if (aborted) throw new IOException("The Recycle Bin did not accept the folder.");
        } finally {
            Marshal.ReleaseComObject(operation);
            Marshal.ReleaseComObject(item);
        }
    }
}
