# Memory troubleshooting (ampone)

This is a practical playbook for DDR5 training failures observed during early boot on
AmpereOne (ASRock Rack `AMPONED8-2T/BCM`).

## "Good" vs "bad" boot signals

Good (DDR init succeeded):

- `MemoryInitExtEntryPoint Done.`
- A `DRAM: <size> DDR5 <speed> ... ECC` line
- UEFI starts (`UEFI firmware ...`) and POST checkpoints advance

Bad (DDR training failure / boot will usually abort):

- `DIMM_VREFDQ SWTrain FAIL`
- `Window = 0 too small (< 6)`
- `PI INIT DONE timeout`
- `DDR Specific Training Error!`
- `DDR failsafe: retry ...` / `failsafe Boot: true` loops

## Slot population order (from the board manual)

Recommended configs:

- `1 DIMM`: `A1`
- `4 DIMMs`: `A1 C1 E1 G1`
- `8 DIMMs`: `A1 B1 C1 D1 E1 F1 G1 H1`

## Fast isolation workflow

Goal: determine whether failures follow a specific DIMM, a specific slot/channel, or only
appear at higher population / higher speed.

1. Baseline with 1 DIMM:
   - Power off.
   - Install a single DIMM in `A1`.
   - Cold restart (power off 30s, then on).
   - Confirm DDR init succeeds (see "Good" signals).

2. If 1 DIMM fails:
   - Reseat the DIMM.
   - Try a different known-good DIMM in `A1`.
   - If multiple DIMMs fail in `A1`, suspect slot contact / CPU seating / firmware.

3. Scale to 4 DIMMs:
   - Populate `A1 C1 E1 G1`.
   - If 4 fails but 1 passes, remove back to 1 and add DIMMs one at a time to find the
     first one that triggers training failures.

4. Scale to 8 DIMMs:
   - Populate the full set.
   - If 8 fails but 4 passes, add the remaining 4 one at a time (`B1`, then `D1`, then
     `F1`, then `H1`) to identify which addition introduces failures.

## "Same model" is not always "same DIMM"

DDR5 RDIMMs can share the same base module part number but still differ in:

- SPD contents / revision
- RCD vendor/revision (registering clock driver)
- PMIC vendor/revision
- thermal sensor vendor/revision

When a mixed set is installed, training can pass at lower population and fail at 8 DIMMs
with `DIMM_VREFDQ SWTrain FAIL` across multiple channels.

Practically:

- Prefer a matched set where all DIMMs report the same SPD/RCD/PMIC signatures in the
  `DRAM populated DIMMs:` boot inventory.
- If the board memory QVL lists a specific suffix (example: `... IMCC`), match that suffix
  when possible.

## Where training data is saved

When you see `frb: Save PHY/DIMM trained data`, that indicates the firmware is caching
training results in platform NVRAM (motherboard firmware storage) for faster subsequent
boots. A "condition change" (DIMM move, firmware update, CMOS clear) can force full
retraining.

## Practical tips

- Use a cold restart for repeatable experiments. Warm resets can leave marginal power/
  training state around.
- If you can reach BIOS with 4 DIMMs but not 8, try lowering memory speed in BIOS before
  adding the last 4 DIMMs.
- BMC SDR DIMM sensors can be `No Reading` while stuck in training; trust the SOL logs
  (`DRAM populated DIMMs:` + training errors) over SDR in that situation.
