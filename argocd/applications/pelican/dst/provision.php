<?php

// One-time, idempotent application-data provisioning through Pelican's native services.
// Run only from a reviewed commit; this does not modify Kubernetes desired state.
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$lock = fopen('/pelican-data/.dst-provision.lock', 'c');
if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
    throw new RuntimeException('Another DST provisioning operation is active.');
}
$externalId = 'galactic-dst';
$eggUuid = 'fae0d457-36d5-4f7b-ab93-f84c46c2762f';
$node = App\Models\Node::where('name', 'galactic-turin')->sole();
$owner = App\Models\User::where('username', 'greg')->sole();
$existing = App\Models\Server::where('external_id', $externalId)->first();
if ($existing) {
    if ($existing->node_id !== $node->id || $existing->owner_id !== $owner->id || $existing->egg->uuid !== $eggUuid) {
        throw new RuntimeException('Existing DST ownership or template differs; inspect before changing it.');
    }
    echo json_encode(['existing' => true, 'id' => $existing->id, 'uuid' => $existing->uuid, 'status' => $existing->status]), PHP_EOL;
    exit(0);
}
$allocations = App\Models\Allocation::where('node_id', $node->id)->where('ip', '0.0.0.0')
    ->whereIn('port', [10999, 11000])->get()->keyBy('port');
if ($allocations->count() !== 2 || $allocations->contains(fn ($allocation) => $allocation->server_id !== null)) {
    throw new RuntimeException('Both reserved DST allocations must be available.');
}
foreach (['memory' => 4096, 'disk' => 12288, 'cpu' => 400] as $field => $required) {
    if (App\Models\Server::where('node_id', $node->id)->sum($field) + $required > $node->$field) {
        throw new RuntimeException("Insufficient node $field capacity.");
    }
}
$runtimeImage = 'ghcr.io/pelican-eggs/steamcmd:debian@sha256:c59cff8cd1202c8f283b8b36344166a9fc16e3f781aa1be7d10187cd9d7566d8';
$installerImage = 'ghcr.io/pelican-eggs/installers:debian@sha256:9c394a48db589e66796d72b058def5e9caf0df8750dc45ef221e653b2a7c3e07';
$launcher = file_get_contents(__DIR__ . '/start.sh');
$install = file_get_contents(__DIR__ . '/install.sh');
if ($launcher === false || $install === false || substr_count($install, '__DST_LAUNCHER__') !== 1) {
    throw new RuntimeException('Reviewed installer/launcher files are missing or invalid.');
}
$install = str_replace('__DST_LAUNCHER__', "printf '%s' '" . base64_encode($launcher) . "' | base64 -d > \"\$HOME/start-dst.sh\"", $install);
$variable = static fn (string $name, string $env, string $value, array $rules, bool $editable = true): array => [
    'name' => $name, 'description' => $name, 'env_variable' => $env, 'default_value' => $value,
    'user_viewable' => true, 'user_editable' => $editable, 'rules' => $rules,
];
$eggData = [
    'meta' => ['version' => 'PLCN_v3', 'update_url' => null],
    'uuid' => $eggUuid,
    'name' => "Don't Starve Together - Galactic",
    'author' => 'admin@pelican.local',
    'description' => 'Private forest + caves. Upload cluster_token.txt before starting. Configurations and saves survive reinstall.',
    'tags' => ['steamcmd'], 'features' => ['steam_disk_space'],
    'docker_images' => ['SteamCMD Debian (pinned)' => $runtimeImage],
    'file_denylist' => [],
    'startup_commands' => ['Forest and Caves' => 'bash ./start-dst.sh'],
    'config' => [
        'files' => ['DoNotStarveTogether/config/server/cluster.ini' => [
            'parser' => 'ini', 'find' => [
                'GAMEPLAY.game_mode' => '{{server.environment.GAME_MODE}}',
                'GAMEPLAY.max_players' => '{{server.environment.MAX_PLAYERS}}',
            ],
        ]],
        'startup' => ['done' => 'Sim paused'], 'logs' => new stdClass(), 'stop' => 'c_shutdown()',
    ],
    'scripts' => ['installation' => ['script' => $install, 'container' => $installerImage, 'entrypoint' => 'bash']],
    'variables' => [
        $variable('Maximum players', 'MAX_PLAYERS', '2', ['required', 'integer', 'between:1,6']),
        $variable('Game mode', 'GAME_MODE', 'survival', ['required', 'in:survival,endless,wilderness']),
        $variable('Steam application', 'SRCDS_APPID', '343050', ['required', 'in:343050'], false),
        $variable('Update on restart', 'AUTO_UPDATE', '0', ['required', 'boolean']),
    ],
];
$egg = app(App\Services\Eggs\Sharing\EggImporterService::class)->fromContent(
    json_encode($eggData, JSON_THROW_ON_ERROR), App\Enums\EggFormat::JSON,
);
$server = app(App\Services\Servers\ServerCreationService::class)->handle([
    'external_id' => $externalId, 'name' => "Don't Starve Together",
    'description' => 'Private Galactic forest + caves; Klei token required before first online start.',
    'owner_id' => $owner->id, 'node_id' => $node->id, 'egg_id' => $egg->id,
    'allocation_id' => $allocations[10999]->id, 'allocation_additional' => [$allocations[11000]->id],
    'memory' => 4096, 'cpu' => 400, 'disk' => 12288, 'swap' => 0, 'io' => 500,
    'oom_killer' => true, 'database_limit' => 0, 'allocation_limit' => 2, 'backup_limit' => 3,
    'environment' => ['MAX_PLAYERS' => '2', 'GAME_MODE' => 'survival', 'SRCDS_APPID' => '343050', 'AUTO_UPDATE' => '0'],
    'start_on_completion' => false,
]);
echo json_encode(['created' => true, 'id' => $server->id, 'uuid' => $server->uuid, 'status' => $server->status]), PHP_EOL;
