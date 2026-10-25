import rerun as rr, sys
rr.init("timmy-r9-probe", recording_id="probe-1")
rr.save(sys.argv[1])
for i in range(3):
    rr.set_time("frame", sequence=i)
    rr.set_time("t", duration=i*0.5)
    rr.log("world/points", rr.Points3D([[0,0,i],[1,1,i]]))
rr.set_time("frame", sequence=7)
rr.log("world/box", rr.Boxes3D(half_sizes=[1,2,3]))
rr.log("notes", rr.TextLog("hello"), static=True)
