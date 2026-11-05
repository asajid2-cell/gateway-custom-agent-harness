// Gateway Manager: the installed "view / repair / uninstall" window.
//
// The uninstaller is Inno's; this is the small thing a person can open when
// they do not know where a program lives. It reads the same HKCU keys the
// installer wrote and only touches files inside the install directory.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Program
{
    private const string KeyName = @"Software\Gateway";

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ManagerForm());
    }

    internal static string Read(string name, string fallback)
    {
        using (var key = Registry.CurrentUser.OpenSubKey(KeyName))
        {
            if (key == null) return fallback;
            var value = key.GetValue(name) as string;
            return string.IsNullOrEmpty(value) ? fallback : value;
        }
    }

    internal static void Write(string name, string value)
    {
        using (var key = Registry.CurrentUser.CreateSubKey(KeyName))
        {
            if (key != null) key.SetValue(name, value, RegistryValueKind.String);
        }
    }
}

internal sealed class ManagerForm : Form
{
    private readonly Label _version = new Label();
    private readonly Label _where = new Label();
    private readonly Label _command = new Label();
    private readonly Label _path = new Label();
    private readonly Label _health = new Label();

    private static string InstallDir { get { return Program.Read("InstallDir", ""); } }
    private static string Alias { get { return Program.Read("Alias", "gateway"); } }

    internal ManagerForm()
    {
        Text = "Gateway Manager";
        Width = 560;
        Height = 320;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9f);

        var heading = new Label
        {
            Text = "Gateway",
            Font = new Font("Segoe UI", 14f, FontStyle.Bold),
            AutoSize = true,
            Left = 20,
            Top = 16
        };

        _version.Left = 20; _version.Top = 58; _version.AutoSize = true;
        _where.Left = 20; _where.Top = 82; _where.AutoSize = true;
        _command.Left = 20; _command.Top = 106; _command.AutoSize = true;
        _path.Left = 20; _path.Top = 130; _path.AutoSize = true;
        _health.Left = 20; _health.Top = 154; _health.AutoSize = true;
        _health.ForeColor = Color.DimGray;

        var open = Button("Open install folder", 20, 196, OpenFolder);
        var rename = Button("Change command name...", 190, 196, ChangeAlias);
        var repair = Button("Repair", 360, 196, Repair);
        var uninstall = Button("Uninstall", 20, 236, Uninstall);
        var close = Button("Close", 360, 236, (s, e) => Close());

        Controls.AddRange(new Control[] { heading, _version, _where, _command, _path, _health, open, rename, repair, uninstall, close });
        Refresh_State();
    }

    private static Button Button(string text, int left, int top, EventHandler handler)
    {
        var button = new Button
        {
            Text = text,
            Left = left,
            Top = top,
            Width = 160,
            Height = 30
        };
        button.Click += handler;
        return button;
    }

    private void Refresh_State()
    {
        var dir = InstallDir;
        _version.Text = "Version: " + Program.Read("Version", "unknown") + "  (build " + Program.Read("SourceSha", "unknown") + ")";
        _where.Text = dir == "" ? "Install folder: not recorded" : "Install folder: " + dir;
        _command.Text = "Command: " + Alias;
        _path.Text = "On PATH: " + (OnPath(dir) ? "yes" : "no");
        if (dir == "")
        {
            _health.Text = "Gateway does not look installed. Use the setup program to install it.";
            return;
        }
        var harness = Path.Combine(dir, "dist\\cli.js");
        var runtime = Path.Combine(dir, "runtime\\bun.exe");
        var missing = 0;
        if (!File.Exists(harness)) missing++;
        if (!File.Exists(runtime)) missing++;
        _health.Text = missing == 0
            ? "Files: complete"
            : "Files: " + missing + " required file(s) missing - use Repair";
        _health.ForeColor = missing == 0 ? Color.DimGray : Color.Firebrick;
    }

    private static bool OnPath(string dir)
    {
        if (dir == "") return false;
        using (var key = Registry.CurrentUser.OpenSubKey("Environment"))
        {
            var path = key == null ? null : key.GetValue("Path") as string;
            if (path == null) return false;
            return (path + ";").IndexOf(Path.Combine(dir, "bin") + ";", StringComparison.OrdinalIgnoreCase) >= 0;
        }
    }

    private void OpenFolder(object sender, EventArgs e)
    {
        var dir = InstallDir;
        if (dir != "" && Directory.Exists(dir)) Process.Start("explorer.exe", "\"" + dir + "\"");
    }

    private void ChangeAlias(object sender, EventArgs e)
    {
        var value = Prompt("Command name", "Type the command you want to use in a terminal:", Alias);
        if (value == null) return;
        value = value.Trim();
        if (value.Length == 0 || value.Length > 32 || value.IndexOfAny(@"\/:*?""<>| ".ToCharArray()) >= 0)
        {
            MessageBox.Show(this, "Use 1-32 characters with no spaces or path characters.", "Gateway", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        var dir = InstallDir;
        if (dir == "") return;
        var bin = Path.Combine(dir, "bin");
        Directory.CreateDirectory(bin);
        WriteShim(bin, "gateway");
        if (!string.Equals(value, "gateway", StringComparison.OrdinalIgnoreCase)) WriteShim(bin, value);
        var old = Alias;
        if (!string.Equals(old, value, StringComparison.OrdinalIgnoreCase) && !string.Equals(old, "gateway", StringComparison.OrdinalIgnoreCase))
        {
            var stale = Path.Combine(bin, old + ".cmd");
            if (File.Exists(stale)) File.Delete(stale);
        }
        Program.Write("Alias", value);
        MessageBox.Show(this, "The command is now \"" + value + "\". Open a new terminal to use it.", "Gateway", MessageBoxButtons.OK, MessageBoxIcon.Information);
        Refresh_State();
    }

    private void Repair(object sender, EventArgs e)
    {
        var dir = InstallDir;
        if (dir == "" || !Directory.Exists(dir))
        {
            MessageBox.Show(this, "Gateway does not look installed. Run the setup program instead.", "Gateway", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        var bin = Path.Combine(dir, "bin");
        Directory.CreateDirectory(bin);
        WriteShim(bin, "gateway");
        WriteShim(bin, Alias);
        AddPath(Path.Combine(dir, "bin"));
        RecreateShortcuts(dir);
        MessageBox.Show(this, "Repair finished: command shims and shortcuts were recreated, and the install folder is on your PATH.", "Gateway", MessageBoxButtons.OK, MessageBoxIcon.Information);
        Refresh_State();
    }

    private static void WriteShim(string bin, string name)
    {
        var target = Path.Combine(bin, "..\\scripts\\cc.cmd");
        var content = "@echo off\r\ncall \"" + target + "\" %*\r\n";
        File.WriteAllText(Path.Combine(bin, name + ".cmd"), content, Encoding.ASCII);
    }

    private static void AddPath(string directory)
    {
        using (var key = Registry.CurrentUser.CreateSubKey("Environment"))
        {
            if (key == null) return;
            var path = key.GetValue("Path") as string ?? "";
            if ((path + ";").IndexOf(directory + ";", StringComparison.OrdinalIgnoreCase) >= 0) return;
            key.SetValue("Path", path.Length == 0 ? directory : path.TrimEnd(';') + ";" + directory, RegistryValueKind.ExpandString);
        }
    }

    private static void RecreateShortcuts(string dir)
    {
        try
        {
            var programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            var group = Path.Combine(programs, "Gateway");
            Directory.CreateDirectory(group);
            Shortcut(Path.Combine(group, "Gateway.lnk"), Path.Combine(dir, "scripts\\cc.cmd"), dir);
            Shortcut(Path.Combine(group, "Gateway Manager.lnk"), Path.Combine(dir, "GatewayManager.exe"), dir);
        }
        catch
        {
            // A missing shortcut is not a reason to fail a repair.
        }
    }

    private static void Shortcut(string file, string target, string working)
    {
        var type = Type.GetTypeFromProgID("WScript.Shell");
        if (type == null) return;
        dynamic shell = Activator.CreateInstance(type);
        dynamic link = shell.CreateShortcut(file);
        link.TargetPath = target;
        link.WorkingDirectory = working;
        link.Save();
    }

    private void Uninstall(object sender, EventArgs e)
    {
        var dir = InstallDir;
        var uninstaller = dir == "" ? null : Path.Combine(dir, "unins000.exe");
        if (uninstaller == null || !File.Exists(uninstaller))
        {
            MessageBox.Show(this, "The uninstaller was not found. Use Windows Settings > Apps to remove Gateway.", "Gateway", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        if (MessageBox.Show(this, "Remove Gateway from this computer?", "Gateway", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        Process.Start(uninstaller);
        Close();
    }

    /// <summary>A one-field dialog; WinForms has no InputBox without VB.</summary>
    private static string Prompt(string title, string label, string initial)
    {
        using (var form = new Form())
        {
            form.Text = title;
            form.Width = 460;
            form.Height = 170;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.MaximizeBox = false;
            form.MinimizeBox = false;

            var text = new Label { Text = label, Left = 16, Top = 16, Width = 410, AutoSize = false, Height = 34 };
            var input = new TextBox { Text = initial, Left = 16, Top = 54, Width = 410 };
            var ok = new Button { Text = "OK", DialogResult = DialogResult.OK, Left = 266, Top = 92, Width = 75 };
            var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Left = 351, Top = 92, Width = 75 };
            form.Controls.AddRange(new Control[] { text, input, ok, cancel });
            form.AcceptButton = ok;
            form.CancelButton = cancel;
            return form.ShowDialog() == DialogResult.OK ? input.Text : null;
        }
    }
}
