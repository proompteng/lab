#!/usr/bin/env python3
import argparse
import concurrent.futures
import json
import time
import urllib.request

def run_once(url, model, prompt, num_predict):
    body = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {"num_predict": num_predict},
    }
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        payload = json.loads(resp.read())
    return payload.get("eval_count", 0)


def run_load(url, model, prompt, num_predict, duration, concurrency):
    end_time = time.time() + duration
    total_eval = 0
    in_flight = set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as ex:
        while time.time() < end_time or in_flight:
            while time.time() < end_time and len(in_flight) < concurrency:
                in_flight.add(ex.submit(run_once, url, model, prompt, num_predict))
            done = [f for f in in_flight if f.done()]
            if not done:
                time.sleep(0.01)
                continue
            for fut in done:
                in_flight.remove(fut)
                try:
                    total_eval += fut.result()
                except Exception:
                    pass
    return total_eval


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:11434/api/generate")
    parser.add_argument("--model", required=True)
    parser.add_argument("--duration", type=int, default=60)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--num-predict", type=int, default=128)
    parser.add_argument("--prompt", default="Summarize the quick brown fox in 3 bullet points.")
    args = parser.parse_args()

    start = time.time()
    total_eval = run_load(
        args.url,
        args.model,
        args.prompt,
        args.num_predict,
        args.duration,
        args.concurrency,
    )
    end = time.time()
    elapsed = end - start
    throughput = total_eval / elapsed if elapsed > 0 else 0
    print(f"total_eval_tokens={total_eval}")
    print(f"elapsed_seconds={elapsed:.2f}")
    print(f"throughput_eval_tokens_per_sec={throughput:.2f}")


if __name__ == "__main__":
    main()
