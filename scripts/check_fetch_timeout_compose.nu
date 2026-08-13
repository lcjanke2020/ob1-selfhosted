# Render each canonical MCP deployment and verify FETCH_TIMEOUT_MS survives
# Compose interpolation. Parsing `docker compose config --format json` keeps
# this regression structural: unrelated YAML formatting cannot make it pass.

def render-compose [files: list<string>] {
    let file_args = ($files | each {|file| ["-f" $file] } | flatten)
    let profile_args = if ($files | any {|file| $file | str ends-with "docker-compose.pattern-b.yml" }) {
        ["--profile" "pattern-b"]
    } else {
        []
    }
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

def render-with-timeout [files: list<string>, timeout?: string] {
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
        if $timeout == null {
            # The parent shell must not be able to turn the default assertion
            # into an accidental override assertion.
            hide-env --ignore-errors FETCH_TIMEOUT_MS
            render-compose $files
        } else {
            with-env { FETCH_TIMEOUT_MS: $timeout } {
                render-compose $files
            }
        }
    }
}

def assert-timeout [name: string, rendered: record, expected: string] {
    let actual = (
        $rendered.services.mcp.environment.FETCH_TIMEOUT_MS?
        | default null
    )
    if $actual != $expected {
        error make {
            msg: $"($name): expected mcp FETCH_TIMEOUT_MS=($expected), got ($actual)"
        }
    }
}

def assert-pattern-b-sink [name: string, rendered: record] {
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
    if "log-sink" not-in ($ingester.depends_on | columns) {
        error make { msg: $"($name): log-ingester does not health-gate on log-sink" }
    }
    if $sink.network_mode != "none" or $sink.ports? != null {
        error make { msg: $"($name): log-sink unexpectedly has a network or published port" }
    }
    if $sink.command != ["postgres" "-c" "listen_addresses="] {
        error make { msg: $"($name): log-sink does not disable Postgres TCP listeners" }
    }
    for required_mount in [
        "/docker-entrypoint-initdb.d/00-log-sink-roles.sh"
        "/docker-entrypoint-initdb.d/01-log-sink.sql"
        "/docker-entrypoint-initdb.d/99-log-sink-assertion.sql"
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
let deployments = [
    {
        name: "compose-local"
        files: [
            ($repo_root | path join "deploy/compose-local/docker-compose.yml")
        ]
    }
    {
        name: "compose-tailnet-overlay"
        files: [
            ($repo_root | path join "deploy/compose-local/docker-compose.yml")
            ($repo_root | path join "deploy/compose-tailnet/docker-compose.pattern-b.yml")
        ]
    }
    {
        name: "compose-external-db-overlay"
        files: [
            ($repo_root | path join "deploy/compose-local/docker-compose.yml")
            ($repo_root | path join "deploy/qubes/docker-compose.external-db.yml")
        ]
    }
    {
        name: "compose-tailnet-external-corpus-overlay"
        files: [
            ($repo_root | path join "deploy/compose-local/docker-compose.yml")
            ($repo_root | path join "deploy/compose-tailnet/docker-compose.pattern-b.yml")
            ($repo_root | path join "deploy/qubes/docker-compose.external-db.yml")
        ]
    }
    {
        name: "qubes-app"
        files: [
            ($repo_root | path join "deploy/qubes/app-qube/docker-compose.yml")
        ]
    }
]
let sentinel = "27182"

# The split Qubes ingress project has no mcp service and therefore no
# FETCH_TIMEOUT_MS contract, but it is still a Pattern B deployment. Render it
# separately so the same structural sink/ingester boundary is enforced for
# every shipped Pattern B shape.
let qubes_ingress = render-with-timeout [
    ($repo_root | path join "deploy/qubes/ingress-qube/docker-compose.yml")
]
assert-pattern-b-sink "qubes-ingress" $qubes_ingress

$deployments | each {|deployment|
    let defaults = (render-with-timeout $deployment.files)
    assert-timeout $"($deployment.name) default" $defaults "15000"
    if "log-sink" in ($defaults.services | columns) {
        assert-pattern-b-sink $deployment.name $defaults
    }

    let overridden = (render-with-timeout $deployment.files $sentinel)
    assert-timeout $"($deployment.name) override" $overridden $sentinel

    {
        deployment: $deployment.name
        default: $defaults.services.mcp.environment.FETCH_TIMEOUT_MS
        override: $overridden.services.mcp.environment.FETCH_TIMEOUT_MS
    }
}
