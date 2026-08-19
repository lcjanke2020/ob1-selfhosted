# Render every shipped Pattern B shape and verify the log-ingester/log-sink
# boundary survives Compose interpolation. Environment-key parity belongs to
# server/scripts/check_compose_env.ts; this check intentionally owns only the
# sink topology and socket-mount invariants named here.

def render-compose [files: list<string>, profiles: list<string>] {
    let file_args = ($files | each {|file| ["-f" $file] } | flatten)
    let profile_args = ($profiles | each {|profile| ["--profile" $profile] } | flatten)
    let result = (
        ^docker compose --env-file /dev/null ...$profile_args ...$file_args config --format json
        | complete
    )
    if $result.exit_code != 0 {
        error make {
            msg: $"docker compose config failed for ($files | str join ', '): ($result.stderr | str trim)"
        }
    }
    $result.stdout | from json
}

def render-pattern-b [files: list<string>, profiles: list<string>] {
    let required = {
        POSTGRES_PASSWORD: "compose-render-superuser"
        OPENBRAIN_APP_PASSWORD: "compose-render-app"
        OPENBRAIN_READONLY_PASSWORD: "compose-render-readonly"
        OPENBRAIN_INGESTER_PASSWORD: "compose-render-ingester"
        OPENBRAIN_LOGS_ROLLUP_PASSWORD: "compose-render-rollup"
        LOG_SINK_SUPERUSER_PASSWORD: "compose-render-sink-admin"
        LOG_SINK_SOCKET_DIR: "/tmp/compose-render-openbrain-log-sink"
        INGESTER_DB_HOST: "/var/run/postgresql"
        MCP_UPSTREAM: "http://127.0.0.1:18787"
        DB_HOST: "db.example"
        METADATA_FALLBACK_POLICY: "off"
        AUTH0_ISSUER: "https://issuer.example/"
        AUTH0_JWKS_URI: "https://issuer.example/jwks"
        AUTH0_AUDIENCE: "https://audience.example"
    }

    with-env $required {
        # Profile activation is deployment metadata below, never ambient shell
        # state. This keeps a caller's COMPOSE_PROFILES from masking an omitted
        # explicit profile argument.
        hide-env --ignore-errors COMPOSE_PROFILES
        render-compose $files $profiles
    }
}

def assert-socket-bind [name: string, service_name: string, service: record] {
    let matches = (
        $service.volumes
        | where target == "/var/run/postgresql"
    )
    if ($matches | length) != 1 {
        error make {
            msg: $"($name): ($service_name) must have exactly one socket bind"
        }
    }

    let mount = ($matches | first)
    let bind = ($mount.bind? | default {})
    if $mount.type? != "bind" {
        error make { msg: $"($name): ($service_name) socket mount is not a bind" }
    }
    if $mount.source? != "/tmp/compose-render-openbrain-log-sink" {
        error make { msg: $"($name): ($service_name) socket bind has the wrong source" }
    }
    if $bind.selinux? != "z" {
        error make { msg: $"($name): ($service_name) socket bind lost SELinux relabel z" }
    }
    # Absence is ambiguous: Compose 2.38 omits false via `omitempty`, while 5.3
    # normalizes explicit true away. The source assertion below is therefore
    # the enforcing create_host_path check; this rejects any observable
    # non-true rendered value.
    let create_host_path = ($bind.create_host_path? | default null)
    if $create_host_path != null and $create_host_path != true {
        error make { msg: $"($name): ($service_name) socket bind rendered create_host_path!=true" }
    }
}

def assert-declared-socket-binds [name: string, path: string] {
    # Nushell's YAML parser does not know Compose's !reset tag. It appears only
    # on an unrelated ports field, so remove the tag marker before inspecting
    # the source mount records (the value itself remains intact).
    let document = try {
        open --raw $path
        | str replace --all "!reset " ""
        | from yaml
    } catch {|error|
        error make {
            msg: $"($name): cannot inspect socket bind declarations in ($path): ($error.msg)"
        }
    }
    for service_name in ["log-ingester" "log-sink"] {
        let volumes = ($document.services | get $service_name | get volumes)
        let matches = (
            $volumes
            | where {|mount|
                (($mount | describe) | str starts-with "record") and $mount.target? == "/var/run/postgresql"
            }
        )
        if ($matches | length) != 1 {
            error make {
                msg: $"($name): ($service_name) must declare exactly one socket bind"
            }
        }

        let mount = ($matches | first)
        if $mount.type? != "bind" or $mount.bind.create_host_path? != true {
            error make {
                msg: $"($name): ($service_name) must declare bind.create_host_path=true"
            }
        }
    }
}

def assert-pattern-b-sink [name: string, rendered: record] {
    let service_names = ($rendered.services | columns)
    for required_service in ["log-ingester" "log-sink"] {
        if $required_service not-in $service_names {
            error make {
                msg: $"($name): Pattern B render omitted required service ($required_service); check profile activation"
            }
        }
    }

    let ingester = $rendered.services | get log-ingester
    let sink = $rendered.services | get log-sink
    let corpus_env = if "postgres" in ($rendered.services | columns) {
        $rendered.services.postgres.environment | columns
    } else {
        []
    }
    let sink_mounts = ($sink.volumes | get target)

    if $ingester.network_mode != "none" {
        error make { msg: $"($name): log-ingester must have network_mode=none" }
    }
    if $ingester.environment.DB_HOST != "/var/run/postgresql" {
        error make { msg: $"($name): log-ingester DB_HOST escaped the sink socket" }
    }
    if $ingester.environment.DB_USER != "openbrain_ingester" {
        error make { msg: $"($name): log-ingester escaped its INSERT-only database role" }
    }
    assert-socket-bind $name "log-ingester" $ingester
    assert-socket-bind $name "log-sink" $sink
    if "log-sink" not-in ($ingester.depends_on | columns) {
        error make { msg: $"($name): log-ingester does not health-gate on log-sink" }
    }
    if $sink.network_mode != "none" or $sink.ports? != null {
        error make { msg: $"($name): log-sink unexpectedly has a network or published port" }
    }
    if $sink.command != ["postgres" "-c" "listen_addresses="] {
        error make { msg: $"($name): log-sink does not disable Postgres TCP listeners" }
    }
    if $sink.entrypoint != ["/bin/sh" "/usr/local/bin/openbrain-log-sink-entrypoint.sh"] {
        error make { msg: $"($name): log-sink does not enforce the init completion marker" }
    }
    if not (($sink.healthcheck.test | str join " ") | str contains ".openbrain-log-sink-init-complete") {
        error make { msg: $"($name): log-sink healthcheck ignores init completion" }
    }
    for required_mount in [
        "/usr/local/bin/openbrain-log-sink-entrypoint.sh"
        "/docker-entrypoint-initdb.d/00-log-sink-roles.sh"
        "/docker-entrypoint-initdb.d/01-log-sink.sql"
        "/docker-entrypoint-initdb.d/99-log-sink-assertion.sql"
        "/docker-entrypoint-initdb.d/zz-log-sink-ready.sh"
    ] {
        if $required_mount not-in $sink_mounts {
            error make { msg: $"($name): log-sink is missing ($required_mount)" }
        }
    }
    for retired_secret in ["OPENBRAIN_INGESTER_PASSWORD" "OPENBRAIN_MONITOR_PASSWORD"] {
        if $retired_secret in $corpus_env {
            error make { msg: $"($name): corpus still receives ($retired_secret)" }
        }
    }
}

let repo_root = ($env.CURRENT_FILE | path dirname | path dirname)
let compose_local = (
    $repo_root | path join "deploy/compose-local/docker-compose.yml"
)
let tailnet_pattern_b = (
    $repo_root | path join "deploy/compose-tailnet/docker-compose.pattern-b.yml"
)
let external_db = (
    $repo_root | path join "deploy/qubes/docker-compose.external-db.yml"
)
let cpu_ollama = (
    $repo_root | path join "deploy/qubes/docker-compose.cpu-ollama.yml"
)
let qubes_ingress = (
    $repo_root | path join "deploy/qubes/ingress-qube/docker-compose.yml"
)

# Compose 2.38.2 preserves create_host_path=true in rendered JSON, while 5.3.1
# normalizes the default-true field away. Check the source declaration as well
# as the rendered mount so both representations enforce the runtime invariant.
assert-declared-socket-binds "compose-tailnet-overlay" $tailnet_pattern_b
assert-declared-socket-binds "qubes-ingress" $qubes_ingress

let deployments = [
    {
        name: "compose-tailnet-overlay"
        profiles: ["pattern-b"]
        files: [$compose_local $tailnet_pattern_b]
    }
    {
        name: "compose-tailnet-external-corpus-overlay"
        profiles: ["pattern-b"]
        files: [$compose_local $tailnet_pattern_b $external_db]
    }
    {
        name: "compose-tailnet-external-corpus-cpu-overlay"
        profiles: ["pattern-b"]
        files: [$compose_local $tailnet_pattern_b $external_db $cpu_ollama]
    }
    {
        name: "qubes-ingress"
        profiles: []
        files: [$qubes_ingress]
    }
]

$deployments | each {|deployment|
    let rendered = (render-pattern-b $deployment.files $deployment.profiles)
    assert-pattern-b-sink $deployment.name $rendered
    {
        deployment: $deployment.name
        ingester_transport: $rendered.services.log-ingester.network_mode
        sink_transport: $rendered.services.log-sink.network_mode
    }
}
