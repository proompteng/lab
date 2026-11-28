<?php

// Run only in the init container, after migrations and the upstream role seeder.
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
config(['panel.email.send_account_created_notification' => false]);

Illuminate\Support\Facades\DB::transaction(function (): void {
    if (!App\Models\User::query()->exists()) {
        app(App\Services\Users\UserCreationService::class)->handle([
            'username' => getenv('ADMIN_USERNAME'),
            'email' => getenv('ADMIN_EMAIL'),
            'password' => getenv('ADMIN_PASSWORD'),
            'root_admin' => true,
        ]);
    }

    $uuid = getenv('WINGS_NODE_UUID');
    $node = App\Models\Node::query()->where('uuid', $uuid)->first();
    if (!$node) {
        if (App\Models\Node::query()->where('fqdn', getenv('WINGS_FQDN'))->exists()) {
            throw new RuntimeException('The Wings hostname already belongs to another node.');
        }
        $node = App\Models\Node::create([
            'name' => 'galactic-turin',
            'description' => 'Dedicated Ubuntu KubeVirt guest on Turin; private tailnet access.',
            'fqdn' => getenv('WINGS_FQDN'),
            'scheme' => 'https',
            'behind_proxy' => true,
            'public' => false,
            'memory' => 4096,
            'memory_overallocate' => 0,
            'disk' => 24576,
            'disk_overallocate' => 0,
            'cpu' => 400,
            'cpu_overallocate' => 0,
            'upload_size' => 256,
            'daemon_listen' => 8080,
            'daemon_connect' => 443,
            'daemon_sftp' => 2022,
            'daemon_sftp_alias' => 'pelican-games.ide-newton.ts.net',
            'daemon_base' => '/var/lib/pelican/volumes',
        ]);
        // Upstream creates random credentials. Bind this new node to the same
        // generated secret delivered to cloud-init, through the encrypted cast.
        $node->forceFill([
            'uuid' => $uuid,
            'daemon_token_id' => getenv('WINGS_TOKEN_ID'),
            'daemon_token' => getenv('WINGS_TOKEN'),
        ])->save();
    }
    if (!hash_equals($node->daemon_token, getenv('WINGS_TOKEN'))
        || !hash_equals($node->daemon_token_id, getenv('WINGS_TOKEN_ID'))) {
        throw new RuntimeException('Wings credentials differ; reconcile the guest and Secret before restarting.');
    }

    foreach ([10999, 11000] as $port) {
        App\Models\Allocation::firstOrCreate([
            'node_id' => $node->id,
            'ip' => '0.0.0.0',
            'port' => $port,
        ], ['ip_alias' => 'pelican-games.ide-newton.ts.net']);
    }
});

echo "Panel administrator and Wings node initialized; existing accounts preserved.\n";
