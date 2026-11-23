#!/usr/bin/env python3
"""Summarize historical records and replay deterministic preprocessing without collection or writes."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import time
from preprocess import normalize_dataset


def summarize(bootstrap, dataset=None, snapshot=None, attempt=None):
    cycle = bootstrap.get('checkpoint', {}).get('value', {}).get('coverage', {}).get('latestCycle', {})
    result = {'baselineVersion': 1, 'provenance': 'Recorded historical run counters; not an independently replayed visual review.',
        'recordedCycleDate': cycle.get('date'), 'recordedPosts': cycle.get('posts'), 'recordedMedia': cycle.get('media'),
        'confirmedApifyUsd': None, 'retainedReservationUsd': None,
        'unavailableHistoricalMetrics': ['ChatGPT tool calls', 'AI token usage', 'per-stage review duration', 'historical transferred bytes'],
        'projections': {'usageReduction': 'Not measured. Mechanical preparation and unchanged comparisons move into scripts; every new visual remains in review.',
                        'quality': 'No quality reduction is intended; equivalent discovery coverage requires observation over actual daily runs.'}}
    run = next((r for r in bootstrap.get('runs', []) if r.get('day') == cycle.get('date') and r.get('reserved_usd')), {})
    result['confirmedApifyUsd'] = run.get('actual_usd')
    result['retainedReservationUsd'] = run.get('reserved_usd') if run.get('actual_usd') is None else 0
    if cycle.get('actorStartedAt') and cycle.get('actorFinishedAt'):
        result['recordedActorSeconds'] = (datetime.fromisoformat(cycle['actorFinishedAt'].replace('Z','+00:00')) - datetime.fromisoformat(cycle['actorStartedAt'].replace('Z','+00:00'))).total_seconds()
    if attempt:
        result['recordedAutomationAttemptSeconds'] = (datetime.fromisoformat(attempt['completed_at'].replace('Z','+00:00')) - datetime.fromisoformat(attempt['started_at'].replace('Z','+00:00'))).total_seconds()
        result['attemptCaution'] = 'An automation attempt can resume an earlier collection; do not add or compare these durations as a full-cycle total.'
    if dataset is not None:
        start = time.perf_counter(); posts, counts = normalize_dataset(dataset)
        result['measuredReplay'] = {'seconds': time.perf_counter() - start, **counts,
            'mediaAssociationsRetainedBeforeScreenedIDLookup': sum(len(p['assets']) for p in posts)}
    if snapshot is not None:
        result['measuredSnapshot'] = {'events': len(snapshot.get('events', [])), 'calendar': len(snapshot.get('calendar', [])),
            'intake': len(snapshot.get('intake', [])), 'compactJsonBytes': len(json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')).encode()),
            'note': 'Fresh full-snapshot serialization, not a historical network measurement.'}
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bootstrap', required=True); parser.add_argument('--dataset'); parser.add_argument('--snapshot'); parser.add_argument('--output', required=True)
    args = parser.parse_args(); read = lambda file: json.loads(Path(file).read_text()) if file else None
    result = summarize(read(args.bootstrap), read(args.dataset), read(args.snapshot))
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ('recordedCycleDate','recordedActorSeconds','confirmedApifyUsd','measuredReplay','measuredSnapshot') if key in result}))
