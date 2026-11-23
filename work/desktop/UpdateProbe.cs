using System;
using System.IO;

internal static class UpdateProbe
{
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1 && args.Length != 4 && args.Length != 5) throw new ArgumentException("Expected package, or package, install, data, failAfter[, lockedFile].");
            var package = UpdatePackage.Read(args[0], args.Length == 1);
            if (args.Length == 1)
            {
                Console.WriteLine("Verified package " + package.version);
                return 0;
            }
            string backup;
            if (args.Length == 5)
                using (var locked = new FileStream(args[4], FileMode.Open, FileAccess.Read, FileShare.Read))
                    backup = UpdateHost.Install(args[0], args[1], args[2], int.Parse(args[3]));
            else backup = UpdateHost.Install(args[0], args[1], args[2], int.Parse(args[3]));
            Console.WriteLine("Backup: " + backup);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
