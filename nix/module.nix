{ config, lib, pkgs, ... }:

let
  cfg = config.services.ted;
in {
  options.services.ted = {
    enable = lib.mkEnableOption "Ted: durable Claude chat over Temporal";

    source = lib.mkOption {
      type = lib.types.path;
      description = "Path to the Ted source checkout (must contain package.json and node_modules).";
      example = "/home/robert/ted";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "robert";
      description = "User to run services as.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "users";
      description = "Group to run services as.";
    };

    temporalAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1:7233";
      description = "Temporal frontend address.";
    };

    temporalUiPort = lib.mkOption {
      type = lib.types.port;
      default = 8233;
    };

    taskQueue = lib.mkOption {
      type = lib.types.str;
      default = "chat";
    };

    webhookPort = lib.mkOption {
      type = lib.types.port;
      default = 8787;
    };

    awsRegion = lib.mkOption {
      type = lib.types.str;
      default = "us-east-1";
    };

    model = lib.mkOption {
      type = lib.types.str;
      default = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
      description = "Bedrock inference profile ID.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Path to a systemd EnvironmentFile containing AWS credentials
        (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, optionally AWS_SESSION_TOKEN).
        If null, the service inherits no AWS credentials — typically only useful
        when the host already provides them via IMDS/SSO.
      '';
      example = "/run/secrets/ted-aws";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the webhook port in the firewall.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ pkgs.temporal-cli pkgs.nodejs_22 ];

    networking.firewall.allowedTCPPorts =
      lib.mkIf cfg.openFirewall [ cfg.webhookPort ];

    # --- Temporal dev server ---
    systemd.services.ted-temporal = {
      description = "Temporal dev server for Ted";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        ExecStart = lib.concatStringsSep " " [
          "${pkgs.temporal-cli}/bin/temporal"
          "server start-dev"
          "--ip 127.0.0.1"
          "--port ${toString (lib.toInt (lib.last (lib.splitString ":" cfg.temporalAddress)))}"
          "--ui-port ${toString cfg.temporalUiPort}"
          "--log-level warn"
        ];
        Restart = "always";
        RestartSec = 2;
      };
    };

    # --- Ted worker ---
    systemd.services.ted-worker = {
      description = "Ted Temporal worker (Claude streaming activity)";
      after = [ "ted-temporal.service" "network.target" ];
      requires = [ "ted-temporal.service" ];
      wantedBy = [ "multi-user.target" ];
      path = [ pkgs.nodejs_22 pkgs.coreutils ];
      environment = {
        TEMPORAL_ADDRESS = cfg.temporalAddress;
        TEMPORAL_NAMESPACE = "default";
        TASK_QUEUE = cfg.taskQueue;
        AWS_REGION = cfg.awsRegion;
        CLAUDE_CODE_USE_BEDROCK = "1";
        ANTHROPIC_MODEL = cfg.model;
      };
      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.source;
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
        ExecStart = "${pkgs.nodejs_22}/bin/node --loader ts-node/esm ${cfg.source}/src/worker.ts";
        Restart = "always";
        RestartSec = 3;
      };
    };

    # --- Ted webhook ---
    systemd.services.ted-webhook = {
      description = "Ted webhook (HTTP -> Temporal signalWithStart)";
      after = [ "ted-temporal.service" "network.target" ];
      requires = [ "ted-temporal.service" ];
      wantedBy = [ "multi-user.target" ];
      path = [ pkgs.nodejs_22 pkgs.coreutils ];
      environment = {
        TEMPORAL_ADDRESS = cfg.temporalAddress;
        TEMPORAL_NAMESPACE = "default";
        TASK_QUEUE = cfg.taskQueue;
        WEBHOOK_PORT = toString cfg.webhookPort;
      };
      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.source;
        ExecStart = "${pkgs.nodejs_22}/bin/node --loader ts-node/esm ${cfg.source}/src/webhook.ts";
        Restart = "always";
        RestartSec = 3;
      };
    };
  };
}
