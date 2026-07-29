# Render each canonical MCP deployment and verify FETCH_TIMEOUT_MS survives
# Compose interpolation. Parsing `docker compose config --format json` keeps
# this regression structural: unrelated YAML formatting cannot make it pass.

def render-compose [files: list<string>] {
    let file_args = ($files | each {|file| ["-f" $file] } | flatten)
    let result = (
        ^docker compose --env-file /dev/null ...$file_args config --format json
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
        DB_HOST: "db.example"
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
        name: "qubes-app"
        files: [
            ($repo_root | path join "deploy/qubes/app-qube/docker-compose.yml")
        ]
    }
]
let sentinel = "27182"

$deployments | each {|deployment|
    let defaults = (render-with-timeout $deployment.files)
    assert-timeout $"($deployment.name) default" $defaults "15000"

    let overridden = (render-with-timeout $deployment.files $sentinel)
    assert-timeout $"($deployment.name) override" $overridden $sentinel

    {
        deployment: $deployment.name
        default: $defaults.services.mcp.environment.FETCH_TIMEOUT_MS
        override: $overridden.services.mcp.environment.FETCH_TIMEOUT_MS
    }
}
