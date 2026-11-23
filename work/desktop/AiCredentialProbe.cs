using System;
using System.IO;
using System.Text;

internal static class AiCredentialProbe
{
    private const string RemoteId = "remote-user";
    private const string LocalId = "local-user";
    private const string Token = "test_admin_token_1234567890_abcdef";

    private static int Main(string[] args)
    {
        try
        {
            var store = new AiCredentialStore(args[0]);
            if (args[1] == "save")
            {
                store.Save(new StoredAiCredential { profileId = RemoteId, kind = "remote", baseUrl = "https://example.org/api", adminToken = Token });
                store.Save(new StoredAiCredential { profileId = LocalId, kind = "local", baseUrl = "http://127.0.0.1:4318", adminToken = Token });
                var files = Directory.GetFiles(Path.Combine(args[0], "AiConnections"));
                if (files.Length != 2) throw new Exception("Expected separate files for each profile.");
                foreach (var file in files)
                    if (Encoding.UTF8.GetString(File.ReadAllBytes(file)).Contains(Token)) throw new Exception("Credential stored as plain text.");
            }
            else if (args[1] == "check")
            {
                var remote = store.Read(RemoteId);
                var local = store.Read(LocalId);
                if (remote == null || remote.adminToken != Token || remote.baseUrl != "https://example.org/api") throw new Exception("Remote credential did not persist.");
                if (local == null || local.kind != "local" || local.adminToken != null) throw new Exception("Local preference did not persist correctly.");
            }
            else if (args[1] == "forget")
            {
                store.Forget(RemoteId);
                if (store.Read(RemoteId) != null || store.Read(LocalId) == null) throw new Exception("Forgot the wrong profile.");
            }
            else throw new ArgumentException("Unknown probe action.");
            Console.WriteLine(args[1] + " OK");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
