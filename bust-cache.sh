#!/bin/bash
# Update version stamps on all JS/CSS files to bust browser cache
BUILD=$(date +%s)
cd /home/ubuntu/ops-tracker/public

# Update all HTML files
for f in *.html; do
  sed -i "s/dashboard\.js?v=[0-9]*/dashboard.js?v=$BUILD/g" "$f"
  sed -i "s/project\.js?v=[0-9]*/project.js?v=$BUILD/g" "$f"
  sed -i "s/utils\.js?v=[0-9]*/utils.js?v=$BUILD/g" "$f"
  sed -i "s/style\.css?v=[0-9]*/style.css?v=$BUILD/g" "$f"
done

# Also add version to files that don't have it yet
sed -i "s/js\/utils\.js\"/js\/utils.js?v=$BUILD\"/g" *.html
sed -i "s/js\/dashboard\.js\"/js\/dashboard.js?v=$BUILD\"/g" *.html
sed -i "s/js\/project\.js\"/js\/project.js?v=$BUILD\"/g" *.html
sed -i "s/css\/style\.css\"/css\/style.css?v=$BUILD\"/g" *.html

echo "[CACHE] Busted all JS/CSS to v=$BUILD"
