#!/bin/bash
while true; do
  echo "Starting localtunnel..."
  npx localtunnel --port 3000 --subdomain cruise-app-live
  echo "Localtunnel crashed, restarting in 2 seconds..."
  sleep 2
done
