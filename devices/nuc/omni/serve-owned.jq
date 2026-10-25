{
  TCP: ((.TCP // {}) | with_entries(select(.key == "443" or .key == "8090" or .key == "8100"))),
  Web: ((.Web // {}) | with_entries(select(.key == ($host + ":443") or .key == ($host + ":8090") or .key == ($host + ":8100")))),
  AllowFunnel: ((.AllowFunnel // {}) | with_entries(select((.key == ($host + ":443") or .key == ($host + ":8090") or .key == ($host + ":8100")) and .value == true)))
}
| if .AllowFunnel == {} then del(.AllowFunnel) else . end
