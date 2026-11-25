// Renders the package-manager manifests of a host release from the built archives:
//   node host/release/render.mjs <version> <dist dir> <source tarball sha256>
// Writes <dist>/manifests/{n2n-nexus-host.rb, n2n-nexus-host.json, winget/*.yaml}.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [version, dist, sourceSha] = process.argv.slice(2);
if (!version || !dist || !sourceSha) {
    console.error("usage: render.mjs <version> <dist dir> <source tarball sha256>");
    process.exit(2);
}
const repo = "https://github.com/n2ns/n2n-nexus";
const tag = `host-v${version}`;
const asset = (name) => `${repo}/releases/download/${tag}/${name}`;
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(path.join(dist, file))).digest("hex");
const zip = (arch) => `n2n-nexus-host_${version}_windows_${arch}.zip`;
const out = path.join(dist, "manifests");
fs.mkdirSync(path.join(out, "winget"), { recursive: true });
const description = "Host of n2n-nexus: lets Claude Code, Codex and pi conversations find and message each other";

// Homebrew: built from source on the user's machine, so Gatekeeper never sees a downloaded binary.
const formulaTemplate = `class N2nNexusHost < Formula
  desc "${description}"
  homepage "${repo}"
  url "${repo}/archive/refs/tags/${tag}.tar.gz"
  version "${version}"
  sha256 "${sourceSha}"
  license "Apache-2.0"

  option "with-nexus-recipe-RECIPE_ID", "Require this release recipe during an automatic update"
  depends_on "go" => :build

  def install
    expected = ENV["N2N_NEXUS_BREW_RECIPE"]
    raise "The formula changed during the update" if expected && expected != "RECIPE_ID"
    system "go", "build", *std_go_args(ldflags: "-s -w -X main.version=#{version}"), "./host/cmd/n2n-nexus-host"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/n2n-nexus-host version").strip
  end
end
`;
const recipeId = createHash("sha256").update(formulaTemplate).digest("hex");
fs.writeFileSync(path.join(out, "n2n-nexus-host.rb"), formulaTemplate.replaceAll("RECIPE_ID", recipeId));

// Scoop
fs.writeFileSync(path.join(out, "n2n-nexus-host.json"), JSON.stringify({
    version,
    description,
    homepage: repo,
    license: "Apache-2.0",
    architecture: {
        "64bit": { url: asset(zip("amd64")), hash: sha256(zip("amd64")) },
        arm64: { url: asset(zip("arm64")), hash: sha256(zip("arm64")) }
    },
    bin: "n2n-nexus-host.exe",
    shortcuts: [["n2n-nexus-host-tray.exe", "n2n-nexus-host"]],
    checkver: { github: repo, regex: "host-v([\\d.]+)" },
    autoupdate: {
        architecture: {
            "64bit": { url: asset(zip("amd64")).replaceAll(version, "$version") },
            arm64: { url: asset(zip("arm64")).replaceAll(version, "$version") }
        }
    }
}, null, 2) + "\n");

// winget (portable exe inside a zip)
const id = "N2NS.n2n-nexus-host";
const header = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.9.0.schema.json\nPackageIdentifier: ${id}\nPackageVersion: ${version}\n`;
fs.writeFileSync(path.join(out, "winget", `${id}.yaml`), `${header("version")}DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.9.0\n`);
fs.writeFileSync(path.join(out, "winget", `${id}.locale.en-US.yaml`), `${header("defaultLocale")}PackageLocale: en-US
Publisher: N2NS Lab
PublisherUrl: https://github.com/n2ns
PackageName: n2n-nexus-host
PackageUrl: ${repo}
License: Apache-2.0
LicenseUrl: ${repo}/blob/main/LICENSE
ShortDescription: ${JSON.stringify(description)}
Moniker: n2n-nexus-host
Tags:
- mcp
- claude-code
- codex
ManifestType: defaultLocale
ManifestVersion: 1.9.0
`);
const installer = (arch, wingetArch) => `- Architecture: ${wingetArch}
  InstallerUrl: ${asset(zip(arch))}
  InstallerSha256: ${sha256(zip(arch)).toUpperCase()}
`;
fs.writeFileSync(path.join(out, "winget", `${id}.installer.yaml`), `${header("installer")}InstallerType: zip
NestedInstallerType: portable
NestedInstallerFiles:
- RelativeFilePath: n2n-nexus-host.exe
  PortableCommandAlias: n2n-nexus-host
- RelativeFilePath: n2n-nexus-host-tray.exe
  PortableCommandAlias: n2n-nexus-host-tray
Installers:
${installer("amd64", "x64")}${installer("arm64", "arm64")}ManifestType: installer
ManifestVersion: 1.9.0
`);
console.log(`manifests written to ${out}`);
