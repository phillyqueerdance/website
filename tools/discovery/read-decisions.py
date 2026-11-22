"""Export the locally saved discovery decisions. Never contacts a remote service."""
import argparse
import json


def read_decisions(state):
    daily = state.get("daily_discovery", {})
    records = daily.get("decisions", [])
    if not isinstance(records, list):
        raise ValueError("Saved decisions must be an array; preserve and recover the existing state.")
    return {
        "records": records,
        "source": "saved_state",
        "lastLiveSyncAt": daily.get("decisionReadAt"),
        "liveAdminFeedback": "Not synced; missing live feedback does not block collection or review.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    with open(args.state) as stream:
        state = json.load(stream)
    result = read_decisions(state)
    with open(args.output, "w") as stream:
        json.dump(result, stream)
    print(json.dumps({"decisionRecords": len(result["records"]), "source": "saved_state"}))
