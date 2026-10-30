#!/usr/bin/env python3
"""
Map the smallest tokenized-stock order that NEAR Intents will quote, using FREE dry quotes only
(`dry: true`: no deposit address, no funds, nothing created). Re-run at different times of day and
on weekends to see how the floor moves.

  set -a; . ./.env; set +a
  python3 scripts/research/equity-min-map.py                       # buys, confidential, default grid
  python3 scripts/research/equity-min-map.py --venue both --side sell
  python3 scripts/research/equity-min-map.py --tickers NVDAon,MSFTon --sizes 5,5.05,5.25,26

Needs ONECLICK_API_KEY and OUTLAYER_ACCOUNT_ID (the recipient used in the quotes) in the environment.
"""
import argparse, concurrent.futures as cf, datetime, json, os, time, urllib.error, urllib.request

API = "https://1click.chaindefuser.com"
KEY = os.environ["ONECLICK_API_KEY"]
WALLET = os.environ["OUTLAYER_ACCOUNT_ID"]
HDR = {"content-type": "application/json", "X-API-Key": KEY, "User-Agent": "norr-research/0.1"}


def get(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(API + path, headers=HDR), timeout=30))


def quote(origin, dest, amount, venue):
    layer = "CONFIDENTIAL_INTENTS" if venue == "confidential" else "INTENTS"
    body = {"dry": True, "swapType": "EXACT_INPUT", "slippageTolerance": 100, "originAsset": origin, "depositType": layer,
            "destinationAsset": dest, "amount": str(amount), "recipient": WALLET, "recipientType": layer,
            "refundTo": WALLET, "refundType": layer,
            "deadline": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}
    if venue == "confidential":
        body["confidentiality"] = "basic"
    for _ in range(3):
        try:
            q = json.load(urllib.request.urlopen(urllib.request.Request(API + "/v0/quote", json.dumps(body).encode(), HDR), timeout=30))["quote"]
            return True, (float(q["amountInUsd"]) - float(q["amountOutUsd"])) / float(q["amountInUsd"]) * 100
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2)
                continue
            return False, json.loads(e.read().decode() or "{}").get("message", str(e.code))
        except Exception:
            time.sleep(1)
    return False, "timeout"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--venue", default="confidential", choices=["public", "confidential", "both"])
    ap.add_argument("--side", default="buy", choices=["buy", "sell"])
    ap.add_argument("--tickers", default="NVDAon,TSLAon,AAPLon,QQQon,SPYon,MSFTon,INTCon,HOODon")
    ap.add_argument("--sizes", default="5,5.05,5.25,6,10,20,25,26,30")
    a = ap.parse_args()
    plain, withondo = get("/v0/tokens"), get("/v0/tokens?ondoTokens=true")
    known = {t["assetId"] for t in plain}
    ondo = {t["symbol"]: t for t in withondo if t["assetId"] not in known}
    usdc = next(t for t in plain if t["symbol"] == "USDC" and t["blockchain"] == "near")
    sizes = [float(s) for s in a.sizes.split(",")]
    print(f"{datetime.datetime.now(datetime.timezone.utc):%A %Y-%m-%d %H:%M}Z  side={a.side}  (cell: OK = quotes, -- = 'No liquidity available')")
    for venue in (["public", "confidential"] if a.venue == "both" else [a.venue]):
        print(f"\n{venue}\n{'ticker':<9}" + "".join(f"${s:<7}" for s in sizes))
        for sym in a.tickers.split(","):
            t = ondo[sym]
            jobs = {}
            with cf.ThreadPoolExecutor(4) as ex:
                for s in sizes:
                    if a.side == "buy":
                        args = (usdc["assetId"], t["assetId"], int(round(s * 1e6)), venue)
                    else:
                        args = (t["assetId"], usdc["assetId"], int(s / t["price"] * 10 ** t["decimals"]), venue)
                    jobs[s] = ex.submit(quote, *args)
            print(f"{sym:<9}" + "".join(f"{('OK' if jobs[s].result()[0] else '--'):<8}" for s in sizes))


main()
