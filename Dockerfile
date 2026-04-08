FROM phemextradebot/bitcointradebot

EXPOSE 80 443 3000

ENV script=growthbot

CMD /bin/bash /start
