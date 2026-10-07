{
  lib,
  stdenv,
  importNpmLock,
  nodejs_24,
  makeWrapper,
  autoPatchelfHook,
  libxcb,
  bash,
  gitMinimal,
  openssh,
  ripgrep,
  fd,
  cloudflared,
  chromium,
  makeFontsConf,
  dejavu_fonts,
}:
let
  package = lib.importJSON ../package.json;
  runtimePackages = [
    nodejs_24
    bash
    gitMinimal
    openssh
    ripgrep
    fd
    cloudflared
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ chromium ];
in
stdenv.mkDerivation {
  pname = "pi-pocket";
  inherit (package) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../bin
      ../src
      ../web
      ../test
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../eslint.config.js
      ../README.md
      ../LICENSE
    ];
  };

  npmDeps = importNpmLock { npmRoot = ../.; };

  nativeBuildInputs = [
    nodejs_24
    importNpmLock.npmConfigHook
    makeWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    stdenv.cc.cc.lib
    libxcb
  ];

  strictDeps = true;
  dontBuild = true;
  dontStrip = true;

  doCheck = true;
  nativeCheckInputs = runtimePackages;
  checkPhase = ''
    runHook preCheck
    ${lib.optionalString stdenv.hostPlatform.isLinux ''
      # The build sandbox cannot host Chromium's sandbox or its shared-memory usage.
      export PI_POCKET_BROWSER_ARGS="--no-sandbox --disable-dev-shm-usage"
      # Plain HTML in the browser tests needs fonts, even without a desktop installed.
      export FONTCONFIG_FILE=${makeFontsConf { fontDirectories = [ dejavu_fonts ]; }}
    ''}
    npm run check
    npm run lint
    npm test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts

    # Node refuses to strip TypeScript under node_modules; keep the app outside it.
    app="$out/share/pi-pocket"
    mkdir -p "$app" "$out/bin"
    cp -r bin src web node_modules package.json README.md LICENSE "$app/"
    # npm's hidden lock contains build-time tarball paths, not runtime dependencies.
    rm -f "$app/node_modules/.package-lock.json"

    makeWrapper ${lib.getExe nodejs_24} "$out/bin/pi-pocket" \
      --add-flags "$app/bin/pi-pocket.js" \
      --suffix PATH : "${lib.makeBinPath runtimePackages}"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/pi-pocket" --help
    runHook postInstallCheck
  '';

  meta = {
    inherit (package) description homepage;
    license = lib.licenses.mit;
    mainProgram = "pi-pocket";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
