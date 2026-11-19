using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// 独立助手不依赖 PowerShell 控制台；握住父进程句柄后通知应用，正常退出后才安装。
internal static class UpdateHelper
{
    private static string Decode(string value)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(value));
    }

    private static int DirectoryLocation(string[] args)
    {
        if (args.Length < 2 || (args[1] != "DataDirectory" && args[1] != "DevelopmentDataDirectory"))
            throw new ArgumentException("数据目录定位参数无效");
        using (Microsoft.Win32.RegistryKey key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey("Software\\YOTOO\\DeployCenter"))
        {
            if (args[0] == "--data-directory-read" && args.Length == 2)
            {
                string value = key.GetValue(args[1], "") as string;
                if (!string.IsNullOrEmpty(value)) Console.Out.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(value)));
            }
            else if (args[0] == "--data-directory-write" && args.Length == 3)
            {
                string value = Decode(args[2]);
                if (!Path.IsPathRooted(value) || value.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0)
                    throw new ArgumentException("数据目录必须是有效的绝对路径");
                key.SetValue(args[1], value, Microsoft.Win32.RegistryValueKind.String);
                key.Flush();
            }
            else throw new ArgumentException("数据目录定位操作无效");
        }
        return 0;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string log = null;
        string executable = null;
        bool silent = false;
        bool ready = false;
        try
        {
            if (args.Length == 2 && args[0] == "--choose-data-directory")
            {
                if (MessageBox.Show("配置的数据目录无法读取，原数据不会被删除。是否重新选择已有数据目录？\n\n" + Decode(args[1]), "YOTOO 部署中心 数据目录恢复", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return 2;
                using (FolderBrowserDialog dialog = new FolderBrowserDialog())
                {
                    dialog.Description = "选择包含 deploy-center.sqlite 的已有数据目录";
                    dialog.ShowNewFolderButton = false;
                    if (dialog.ShowDialog() != DialogResult.OK) return 2;
                    Console.Out.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(dialog.SelectedPath)));
                    return 0;
                }
            }
            // 注册表仅保存目录位置，内容经 UTF-8/Base64 传递，避免中文系统代码页差异。
            if (args.Length > 0 && args[0].StartsWith("--data-directory-", StringComparison.Ordinal))
                return DirectoryLocation(args);
            int pid;
            if ((args.Length != 5 && args.Length != 7) || !int.TryParse(args[0], out pid) || pid <= 0)
                throw new ArgumentException("更新安装参数无效");
            string file = Decode(args[1]);
            string expected = args[2];
            string directory = Decode(args[3]);
            log = Decode(args[4]);
            silent = args.Length == 7;
            if (silent)
            {
                executable = Decode(args[6]);
                if (!System.Text.RegularExpressions.Regex.IsMatch(args[5], "\\A[0-9]+\\.[0-9]+\\.[0-9]+\\z") ||
                    !String.Equals(Path.GetDirectoryName(Path.GetFullPath(executable)), Path.GetFullPath(directory), StringComparison.OrdinalIgnoreCase) ||
                    !File.Exists(executable))
                    throw new ArgumentException("静默更新的原安装位置或版本无效");
            }
            if (!System.Text.RegularExpressions.Regex.IsMatch(expected, "\\A[a-f0-9]{64}\\z"))
                throw new ArgumentException("安装包指纹无效");
            using (Process parent = Process.GetProcessById(pid))
            {
                IntPtr handle = parent.Handle;
                Console.Out.WriteLine("UPDATE_READY");
                Console.Out.Flush();
                ready = true;
                parent.WaitForExit();
            }
            // 与原流程一致：等待同名 Electron 子进程自然退出，不强制终止任何进程。
            DateTime deadline = DateTime.UtcNow.AddSeconds(30);
            string[] names = silent ? new[] { Path.GetFileNameWithoutExtension(executable) } : new[] { "YOTOO 部署中心", "Deploy Center" };
            while (true)
            {
                bool busy = false;
                foreach (string name in names)
                    foreach (Process process in Process.GetProcessesByName(name))
                    {
                        busy = true;
                        process.Dispose();
                    }
                if (!busy) break;
                if (DateTime.UtcNow >= deadline)
                    throw new InvalidOperationException("应用仍有进程运行，请关闭其他窗口后重试");
                Thread.Sleep(250);
            }
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("安装包不能是链接");
            ProcessStartInfo start = new ProcessStartInfo(file);
            start.WorkingDirectory = Path.GetDirectoryName(file);
            start.UseShellExecute = !silent;
            start.CreateNoWindow = silent;
            // NSIS 的 /D= 必须放在最后，包含空格时也不要加引号。
            start.Arguments = (silent ? "/S /YOTOOUPDATE " : "") + "/D=" + directory;
            Process launchedInstaller;
            // 从计算摘要到创建进程都阻止替换缓存文件，避免校验后启动了不同内容。
            using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (SHA256 sha = SHA256.Create())
            {
                string actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (actual != expected) throw new InvalidOperationException("安装包校验失败");
                launchedInstaller = Process.Start(start);
            }
            using (Process installer = launchedInstaller)
            {
                if (silent)
                {
                    installer.WaitForExit();
                    if (installer.ExitCode != 0)
                        throw new InvalidOperationException("安装程序退出码：" + installer.ExitCode);
                    string installedVersion = File.Exists(executable) ? FileVersionInfo.GetVersionInfo(executable).ProductVersion : "";
                    if (installedVersion != args[5] && installedVersion != args[5] + ".0")
                        throw new InvalidOperationException("安装完成后未找到预期版本");
                }
            }
            if (silent) Restart(executable);
            return 0;
        }
        catch (Exception error)
        {
            string message = "更新安装未完成。请查看更新日志后重试。\n" + error.Message;
            try
            {
                if (log != null) File.AppendAllText(log, DateTime.Now.ToString("s") + " 更新安装未启动：" + error + Environment.NewLine, Encoding.UTF8);
            }
            catch { /* 日志不可写时仍反馈启动失败，不允许应用误以为交接成功。 */ }
            if (ready && silent && executable != null && File.Exists(executable))
            {
                try
                {
                    File.WriteAllText(Path.Combine(Path.GetDirectoryName(log), "last-update-error.txt"), message, Encoding.UTF8);
                    Restart(executable);
                    return 1;
                }
                catch { /* 无法重新打开应用时，使用系统对话框说明失败。 */ }
            }
            if (ready) MessageBox.Show(message, "YOTOO 部署中心 更新失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            else Console.Error.WriteLine(message);
            return 1;
        }
    }
    private static void Restart(string executable)
    {
        ProcessStartInfo restart = new ProcessStartInfo(executable);
        restart.WorkingDirectory = Path.GetDirectoryName(executable);
        restart.UseShellExecute = false;
        using (Process process = Process.Start(restart)) { }
    }
}
