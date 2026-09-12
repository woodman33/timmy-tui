// Unity · batch-build: the static method -executeMethod calls. Copied into Assets/Editor by unpack.mjs.
// Reads -shelfOut <dir> from the command line and builds every enabled scene for WebGL.
using System;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Shelf
{
    public static class Build
    {
        static string Arg(string name)
        {
            var args = Environment.GetCommandLineArgs();
            for (var i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
            return null;
        }

        public static void WebGL()
        {
            var outDir = Arg("-shelfOut") ?? "Build/WebGL";
            var scenes = EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray();
            if (scenes.Length == 0) { Debug.LogError("shelf: no enabled scenes in EditorBuildSettings"); EditorApplication.Exit(2); return; }
            var report = BuildPipeline.BuildPlayer(scenes, outDir, BuildTarget.WebGL, BuildOptions.None);
            var ok = report.summary.result == UnityEditor.Build.Reporting.BuildResult.Succeeded;
            Debug.Log($"shelf: build {(ok ? "succeeded" : "FAILED")} → {outDir} ({report.summary.totalSize} bytes, {report.summary.totalErrors} errors)");
            EditorApplication.Exit(ok ? 0 : 1);
        }
    }
}
