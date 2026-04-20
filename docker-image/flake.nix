{
  description = "Nix-built Docker image with Claude Code CLI for AWS Bedrock";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };

        # Entrypoint: reads JSON from stdin ({ prompt: string, ...}) and runs
        # claude in non-interactive print mode. Output is the assistant reply.
        entrypoint = pkgs.writeShellScript "entrypoint" ''
          set -eu
          export HOME=''${HOME:-/tmp}
          export PATH=${pkgs.lib.makeBinPath [
            pkgs.claude-code
            pkgs.nodejs_22
            pkgs.chromium
            pkgs.git
            pkgs.curl
            pkgs.coreutils
            pkgs.bashInteractive
          ]}
          # Bedrock toggle — callers can override by unsetting.
          : "''${CLAUDE_CODE_USE_BEDROCK:=1}"
          : "''${AWS_REGION:=us-east-1}"
          export CLAUDE_CODE_USE_BEDROCK AWS_REGION

          if [ -t 0 ]; then
            # TTY — pass args straight through to claude for interactive use.
            exec claude "$@"
          fi
          # Non-interactive: read stdin into -p (print mode).
          input="$(cat)"
          exec claude -p "$input" "$@"
        '';

        image = pkgs.dockerTools.buildLayeredImage {
          name = "claude-agent";
          tag = "latest";
          contents = [
            pkgs.claude-code
            pkgs.nodejs_22
            pkgs.chromium
            pkgs.git
            pkgs.curl
            pkgs.coreutils
            pkgs.bashInteractive
            pkgs.cacert
            # /tmp and /workspace
            (pkgs.runCommand "workspace-dirs" {} ''
              mkdir -p $out/tmp $out/workspace $out/home/node
              chmod 1777 $out/tmp
            '')
          ];
          config = {
            Entrypoint = [ "${entrypoint}" ];
            Env = [
              "PATH=${pkgs.lib.makeBinPath [
                pkgs.claude-code
                pkgs.nodejs_22
                pkgs.chromium
                pkgs.git
                pkgs.curl
                pkgs.coreutils
                pkgs.bashInteractive
              ]}"
              "HOME=/home/node"
              "CLAUDE_CODE_USE_BEDROCK=1"
              "AGENT_BROWSER_EXECUTABLE_PATH=${pkgs.chromium}/bin/chromium"
              "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${pkgs.chromium}/bin/chromium"
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              "NODE_EXTRA_CA_CERTS=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            ];
            WorkingDir = "/workspace";
          };
        };
      in {
        packages = {
          default = image;
          image = image;
        };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.claude-code pkgs.nodejs_22 pkgs.awscli2 pkgs.skopeo pkgs.podman ];
        };
      });
}
