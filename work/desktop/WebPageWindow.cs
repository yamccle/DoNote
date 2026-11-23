using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed partial class WorkspaceWindow
{
    private bool HandleLivePageCommand(CoreWebView2 web, CoreWebView2WebMessageReceivedEventArgs args)
    {
        string command;
        try { command = args.TryGetWebMessageAsString(); }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        const string prefix = "open-live-webpage:";
        if (command == null || !command.StartsWith(prefix, StringComparison.Ordinal)) return false;

        try
        {
            var request = json.Deserialize<Dictionary<string, string>>(command.Substring(prefix.Length));
            Uri source;
            string url, recordId, profileId;
            if (request == null || !request.TryGetValue("url", out url) || !IsPublicWebAddress(url, out source)
                || !request.TryGetValue("recordId", out recordId) || !IsValidWebRecordId(recordId)
                || !request.TryGetValue("profileId", out profileId) || !IsValidWebRecordId(profileId))
                throw new ArgumentException("网页地址或记录编号无效。");
            OpenLivePage(web, source, recordId, profileId);
        }
        catch (Exception error) { MessageBox.Show(this, "无法打开原网页。\n" + error.Message, Text); }
        return true;
    }

    private static bool IsValidWebRecordId(string value)
    {
        return value != null && Regex.IsMatch(value, @"\A[a-zA-Z0-9-]{1,80}\z");
    }

    private async void OpenLivePage(CoreWebView2 workspace, Uri source, string recordId, string profileId)
    {
        var window = new Form
        {
            Text = "原网页标注 · " + source.IdnHost,
            Icon = Icon,
            Size = new Size(1140, 850),
            MinimumSize = new Size(570, 450),
            StartPosition = FormStartPosition.CenterParent,
        };
        var view = new WebView2 { Dock = DockStyle.Fill };
        var toolbar = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 3, Padding = new Padding(8) };
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var label = new Label { Text = "选中文字后添加备注（可选）", AutoSize = true, Anchor = AnchorStyles.Left };
        var note = new TextBox { MaxLength = 1200, Dock = DockStyle.Fill, AccessibleName = "备注" };
        var save = new Button { Text = "保存所选文字", AutoSize = true, Enabled = false };
        toolbar.Controls.Add(label, 0, 0);
        toolbar.Controls.Add(note, 1, 0);
        toolbar.Controls.Add(save, 2, 0);
        window.Controls.Add(view);
        window.Controls.Add(toolbar);
        window.Show(this);
        try
        {
            var environment = workspace.Environment;
            var options = environment.CreateCoreWebView2ControllerOptions();
            options.ProfileName = "PublicWebPages";
            options.IsInPrivateModeEnabled = true;
            await view.EnsureCoreWebView2Async(environment, options);
            if (window.IsDisposed) return;
            var live = view.CoreWebView2;
            live.Settings.IsWebMessageEnabled = false;
            live.Settings.AreHostObjectsAllowed = false;
            live.Settings.AreDevToolsEnabled = false;
            live.Settings.IsPasswordAutosaveEnabled = false;
            live.Settings.IsGeneralAutofillEnabled = false;
            live.NewWindowRequested += (sender, args) => { args.Handled = true; };
            live.PermissionRequested += (sender, args) => { args.State = CoreWebView2PermissionState.Deny; };
            live.DownloadStarting += (sender, args) => { args.Cancel = true; args.Handled = true; };
            live.NavigationStarting += (sender, args) =>
            {
                Uri address;
                if (!IsPublicWebAddress(args.Uri, out address)
                    || Uri.Compare(address, source, UriComponents.HttpRequestUrl, UriFormat.UriEscaped, StringComparison.Ordinal) != 0)
                    args.Cancel = true;
            };
            live.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            live.WebResourceRequested += (sender, args) =>
            {
                Uri address;
                if (!IsPublicWebAddress(args.Request.Uri, out address))
                    args.Response = environment.CreateWebResourceResponse(null, 403, "Forbidden", "");
            };
            live.NavigationCompleted += (sender, args) =>
            {
                save.Enabled = args.IsSuccess;
                if (!args.IsSuccess && args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
                    MessageBox.Show(window, "原网页当前无法加载。可以返回工作台阅读已存快照。", Text);
            };
            save.Click += async (sender, args) =>
            {
                save.Enabled = false;
                try
                {
                    string result = await live.ExecuteScriptAsync("String(window.getSelection()).trim().slice(0, 2000)");
                    if (window.IsDisposed) return;
                    var selection = new System.Web.Script.Serialization.JavaScriptSerializer { MaxJsonLength = 32000 };
                    string quote = selection.Deserialize<string>(result);
                    if (string.IsNullOrWhiteSpace(quote))
                    {
                        MessageBox.Show(window, "请先在网页上选中文字。", Text);
                        return;
                    }
                    PostWorkspaceMessage(workspace, new { type = "yams-one-live-annotation", recordId, profileId, quote, note = note.Text.Trim() });
                    note.Clear();
                    label.Text = "摘录已发送 · 返回工作台查看";
                }
                catch (Exception error) { if (!window.IsDisposed) MessageBox.Show(window, error.Message, Text); }
                finally { if (!window.IsDisposed) save.Enabled = true; }
            };
            live.Navigate(source.AbsoluteUri);
        }
        catch (Exception error)
        {
            if (!window.IsDisposed)
            {
                MessageBox.Show(window, "无法加载原网页。可以返回工作台阅读已存快照。\n" + error.Message, Text);
                window.Close();
            }
        }
    }
}
