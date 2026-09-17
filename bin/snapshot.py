#!/usr/bin/env python3
"""One JSON snapshot for the HUD: time logged today and this week, the
Deployed estimate for the sprint window, and the branch's ticket."""
import argparse
import io
import json
import sys
from contextlib import redirect_stdout
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path.home() / '.agents' / 'skills' / 'jira-time-today'))

import get_time as jt  # noqa: E402


def logged_seconds(base_url, username, token, account_id, start, end):
    jql = (
        f'worklogDate >= {start:%Y-%m-%d} AND worklogDate <= {end:%Y-%m-%d} '
        'AND worklogAuthor = currentUser()'
    )
    issues = jt.jira_search_all(base_url, username, token, jql, ['key'])
    today_s = 0
    week_s = 0
    today = datetime.now().date()

    for issue in issues:
        worklogs = jt.curl_jira(
            f'{base_url}/rest/api/3/issue/{issue["key"]}/worklog'
            f'?startedAfter={int(datetime.combine(start, datetime.min.time()).timestamp() * 1000)}',
            username, token,
        )
        for worklog in worklogs.get('worklogs', []):
            if worklog.get('author', {}).get('accountId') != account_id:
                continue
            started = datetime.fromisoformat(worklog['started'].replace('Z', '+00:00')).astimezone().date()
            if start <= started <= end:
                week_s += worklog['timeSpentSeconds']
                if started == today:
                    today_s += worklog['timeSpentSeconds']

    return today_s, week_s


def deployed(base_url, username, token):
    start, end = jt.get_current_sprint_change_window()
    window = (f'{start:%Y-%m-%d %H:%M}', f'{end:%Y-%m-%d %H:%M}')
    fields = ['key', 'timetracking']
    done = jt.jira_search_all(
        base_url, username, token,
        'status = Deployed AND assignee = currentUser() AND sprint in openSprints() '
        f'AND status CHANGED TO Deployed DURING ("{window[0]}", "{window[1]}")',
        fields,
    )
    pending = jt.jira_search_all(
        base_url, username, token,
        'status != Deployed AND assignee = currentUser() AND sprint in openSprints()',
        fields,
    )
    return {
        'seconds': jt.summarize_original_estimates(done)[0],
        'pending_seconds': jt.summarize_original_estimates(pending)[0],
        'min_seconds': jt.DEPLOYED_TARGET_MIN_SECONDS,
        'max_seconds': jt.DEPLOYED_TARGET_MAX_SECONDS,
        'window_end': end.isoformat(),
    }


def ticket(base_url, username, token, key):
    issue = jt.curl_jira(
        f'{base_url}/rest/api/3/issue/{key}?fields=summary,status,timetracking',
        username, token,
    )
    if 'fields' not in issue:
        return {'key': key, 'missing': True}

    tracking = issue['fields'].get('timetracking') or {}
    return {
        'key': key,
        'summary': issue['fields'].get('summary', ''),
        'status': issue['fields'].get('status', {}).get('name', ''),
        'original_seconds': tracking.get('originalEstimateSeconds') or 0,
        'spent_seconds': tracking.get('timeSpentSeconds') or 0,
        'remaining_seconds': tracking.get('remainingEstimateSeconds') or 0,
        'url': f'{base_url}/browse/{key}',
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--issue')
    args = parser.parse_args()

    # get_time.py prints its errors and exits; keep them out of the JSON.
    captured = io.StringIO()
    try:
        with redirect_stdout(captured):
            config = jt.load_config(config_path=None, env_path=None)
            base_url = config['jira_api_base_url'].rstrip('/')
            username = config['jira_api_username']
            token = config['jira_api_token']
            account_id = jt.curl_jira(f'{base_url}/rest/api/3/myself', username, token)['accountId']

            today = datetime.now().date()
            week_start = today - timedelta(days=today.weekday())
            today_s, week_s = logged_seconds(base_url, username, token, account_id, week_start, today)

            snapshot = {
                'today_seconds': today_s,
                'week_seconds': week_s,
                'deployed': deployed(base_url, username, token),
                'issue': ticket(base_url, username, token, args.issue) if args.issue else None,
                'fetched_at': datetime.now().isoformat(timespec='seconds'),
            }
    except SystemExit:
        snapshot = {'error': captured.getvalue().strip() or 'Jira query failed'}
    except Exception as error:  # noqa: BLE001
        snapshot = {'error': f'{type(error).__name__}: {error}'}

    print(json.dumps(snapshot))


if __name__ == '__main__':
    main()
