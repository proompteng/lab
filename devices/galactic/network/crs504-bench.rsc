# CRS504 bench setup. Keep ether1 connected directly to the Mac at 192.168.88.2/24.
# Requires the factory bridge and management address, or this converged configuration.
:if ([/system routerboard get model] != "CRS504-4XQ") do={ :error "Expected CRS504-4XQ" }
:if ([:len [/interface bridge find]] != 1) do={ :error "Expected one bridge" }
:if ([:len [/ip address find where address="192.168.88.1/24"]] != 1) do={ :error "Expected bench management address" }

/system identity set name=galactic-storage
/ip address set [find where address="192.168.88.1/24"] interface=ether1 comment="Bench management"
/interface bridge port remove [find where interface!="qsfp28-1-1" && interface!="qsfp28-2-1"]
/interface bridge set [find] name=storage mtu=1500 protocol-mode=rstp auto-mac=no admin-mac=[/interface ethernet get qsfp28-1-1 mac-address] comment="100G storage"
/interface bridge port set [find] hw=yes

# Keep all four lanes enabled for each active whole 100G port.
/interface ethernet set [find where default-name~"^qsfp28-[12]-"] disabled=no mtu=1500
/interface ethernet set qsfp28-1-1 auto-negotiation=yes advertise=100G-baseCR4 speed=100G-baseCR4 fec-mode=fec91 comment="Altra port 1"
/interface ethernet set qsfp28-2-1 auto-negotiation=yes advertise=100G-baseCR4 speed=100G-baseCR4 fec-mode=fec91 comment="Turin port 1"
/interface ethernet set [find where default-name~"^qsfp28-[34]-"] disabled=yes
/interface ethernet set ether1 comment="Bench management - Mac USB Ethernet"

/ip settings set ip-forward=no
/ipv6 settings set forward=no
:if ([:len [/interface list find where name="management"]] = 0) do={ /interface list add name=management }
:if ([:len [/interface list member find where list="management" && interface="ether1"]] = 0) do={ /interface list member add list=management interface=ether1 }
/ip neighbor discovery-settings set discover-interface-list=management
/tool mac-server set allowed-interface-list=none
/tool mac-server mac-winbox set allowed-interface-list=management
/ip service set [find where name="telnet" || name="ftp" || name="api" || name="api-ssl"] disabled=yes
/ip service set [find where name="ssh" || name="www" || name="winbox"] address=192.168.88.0/24
/system package update set channel=long-term
