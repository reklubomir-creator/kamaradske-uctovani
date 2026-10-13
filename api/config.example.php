<?php
declare(strict_types=1);

/*
 * Copy this file to config.php on the hosting server.
 * Never commit real database credentials to Git.
 */
return [
    'db_host' => 'localhost',
    'db_name' => 'CHANGE_ME',
    'db_user' => 'CHANGE_ME',
    'db_password' => 'CHANGE_ME',
    'allowed_origins' => [
        'https://reklubomir-creator.github.io',
        // Add the final custom domain origin here when it exists.
    ],
];
