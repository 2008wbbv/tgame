// The intended keystrokes for each mission, shared by the engine and the
// server integration tests.
export const SOLUTIONS = {
  recon: ['pwd > recon.txt'],
  'read-the-log': ['grep "Failed password" /var/log/auth.log > ~/failed.txt'],
  'count-attackers': ['echo 45.9.14.7 > attacker.txt'],
  'fix-perms': ['chmod 600 ~/.ssh/id_rsa'],
  'make-it-run': ['chmod +x /srv/deploy.sh'],
  organise: ['mkdir /srv/archive', 'mv /tmp/nginx.log /tmp/cron.log /srv/archive'],
  'free-the-disk': ['sudo rm /var/log/huge.log'],
  'kill-the-miner': ['sudo kill 4471'],
  'hand-over-webroot': ['sudo chown -R op /var/www/html'],
  'audit-suid': ['find /srv -type f -user root > ~/audit.txt'],
  'restore-service': [
    'sudo mkdir -p /etc/nginx',
    'sudo echo "listen 443;" > /etc/nginx/nginx.conf',
    'sudo rm /tmp/nginx.pid',
  ],
};
