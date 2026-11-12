def valid_iterations:
  .iterations as $iterations |
  ($iterations | length) > 0 and
  all(range(0; $iterations | length);
    . as $index | $iterations[$index] as $iteration |
    $iteration.iteration == $index + 1 and
    $iteration.end > $iteration.start and
    $iteration.rebuild == true and $iteration.exitCode == 0 and
    $iteration.image.os == "linux" and $iteration.image.architecture == "amd64" and
    ($iteration.image.digest | test("^sha256:[0-9a-f]{64}$")) and
    (if $index == 0 then true else $iteration.start >= $iterations[$index - 1].end end));

# Ordered nonoverlapping intervals permit at most one active interval per runner.
# Group simultaneous starts/ends before the sweep, so adjacent intervals neither
# double-count time nor create a false gap. Only ten-way active time contributes.
def common_native_work_seconds:
  [.[] | .iterations[] | {time:.start,change:1}, {time:.end,change:-1}] |
  group_by(.time) |
  map({time:.[0].time,change:(map(.change) | add)}) |
  reduce .[] as $event ({active:0,previous:null,seconds:0};
    (if .active == 10 then .seconds += $event.time - .previous else . end) |
    .active += $event.change |
    .previous = $event.time) |
  .seconds;

if (
  length == 10 and
  ([.[].slot] | sort) == [1,2,3,4,5,6,7,8,9,10] and
  ([.[].pod] | unique | length) == 10 and
  ([.[].scratchDevice] | unique | length) == 10 and
  all(.[];
    .schemaVersion == "arc.native-image-qualification.v1" and
    .status == "passed" and .exitCode == 0 and
    .sourceRevision == $source and .packageAttr == "bayn-image" and .role == "build" and
    .node == "turin" and .scratchFilesystem == "ext4" and
    (.scratchDevice | test("^/dev/rbd[0-9]+$")) and
    valid_iterations and
    .nativeStart == .iterations[0].start and
    .nativeEnd == .iterations[-1].end and
    .nativeEnd - .nativeStart >= 2100)
) | not then
  error("Native receipts must describe ten distinct Turin RBD builders with successful, ordered, nonoverlapping rebuild/inspection iterations at the dispatch source")
else
  common_native_work_seconds as $seconds |
  if $seconds < 1800 then
    error("Common native rebuild/inspection work was only \($seconds) seconds after excluding iteration gaps; at least 1800 seconds are required")
  else
    {sourceRevision:.[0].sourceRevision,builders:length,
      commonStart:([.[].nativeStart] | max),commonEnd:([.[].nativeEnd] | min),
      commonNativeWorkSeconds:$seconds,
      completedRebuilds:([.[].iterations | length] | add)}
  end
end
