#!/usr/bin/env bash
# Stateful gh stub for the early-warning issue tests; install it as `gh` on
# PATH. Issues live in the JSON array at $STATE ({number, state, title, body,
# author, url, comments: [{body, author}]}), every call is appended to $GH_LOG,
# and everything it creates is authored by github-actions[bot] (the workflow's
# identity). `issue list` honours --state. STUB_FAIL="issue reopen" (for
# example; "api" for the REST reads) makes that call fail without changing
# anything, as an API outage would; STUB_MALFORMED=1 garbles the REST reads.
# shellcheck disable=SC2016,SC2153 # jq programs in single quotes; STATE from the environment
set -euo pipefail
bot="github-actions[bot]"
if [[ $1 == api ]]; then
  path=${*: -1}
  echo "api $path" >>"$GH_LOG"
  if [[ ${STUB_FAIL:-} == api ]]; then echo "HTTP 503: injected" >&2; exit 1; fi
  if [[ -n ${STUB_MALFORMED:-} ]]; then echo "not json"; exit 0; fi
  n=$(sed -E 's#.*/issues/([0-9]+).*#\1#' <<<"$path")
  user='{login: ., type: (if endswith("[bot]") then "Bot" else "User" end)}'
  case $path in
    */comments)
      jq --argjson n "$n" ".[] | select(.number == \$n) |
        [.comments[] | {body, user: (.author | $user)}]" "$STATE" ;;
    *) jq --argjson n "$n" ".[] | select(.number == \$n) |
        {number, body, user: (.author | $user)}" "$STATE" ;;
  esac
  exit 0
fi
cmd="$1 $2"
shift 2
number="" title="" state=all
if [[ ${1:-} =~ ^[0-9]+$ ]]; then number=$1; shift; fi
while (($#)); do
  case $1 in
    --title) title=$2; shift 2 ;;
    --state) state=$2; shift 2 ;;
    *) shift ;;
  esac
done
echo "$cmd $number" >>"$GH_LOG"
if [[ $cmd == "${STUB_FAIL:-}" ]]; then echo "HTTP 503: injected" >&2; exit 1; fi
update() { jq "$@" "$STATE" >"$STATE.tmp" && mv "$STATE.tmp" "$STATE"; }
case $cmd in
  "label create") ;;
  "issue list")
    jq --arg s "$state" '[.[] | select($s == "all" or (.state | ascii_downcase) == $s) |
      {number, state, title, url}]' "$STATE" ;;
  "issue view")
    jq --argjson n "$number" \
      '.[] | select(.number == $n) | {body, comments: [.comments[] | {body}]}' "$STATE" ;;
  "issue create")
    body=$(cat)
    number=$(jq '([.[].number] | max // 0) + 1' "$STATE")
    update --argjson n "$number" --arg t "$title" --arg b "$body" --arg a "$bot" \
      '. + [{number: $n, state: "OPEN", title: $t, body: $b, author: $a,
             comments: [], url: "https://github.com/o/r/issues/\($n)"}]'
    echo "https://github.com/o/r/issues/$number" ;;
  "issue comment")
    body=$(cat)
    update --argjson n "$number" --arg b "$body" --arg a "$bot" \
      'map(if .number == $n then .comments += [{body: $b, author: $a}] else . end)' ;;
  "issue edit")
    update --argjson n "$number" --arg t "$title" \
      'map(if .number == $n then .title = $t else . end)' ;;
  "issue close")
    update --argjson n "$number" 'map(if .number == $n then .state = "CLOSED" else . end)' ;;
  "issue reopen")
    update --argjson n "$number" 'map(if .number == $n then .state = "OPEN" else . end)' ;;
  *) echo "unexpected: gh $cmd" >&2; exit 1 ;;
esac
